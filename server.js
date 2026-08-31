import cors from "cors";
import "dotenv/config";
import express from "express";

const app = express();

const PORT = positiveInteger(process.env.PORT, 3001);
const JEDLIK_API_BASE = (
  process.env.JEDLIK_API_BASE ??
  "https://jedlikinfo.jedlik.eu/api/api/timetable"
).replace(/\/$/, "");

const UPSTREAM_TIMEOUT_MS = positiveInteger(
  process.env.UPSTREAM_TIMEOUT_MS,
  8_000,
);

const CACHE_TTL_MS = positiveInteger(
  process.env.CACHE_TTL_MS,
  5 * 60_000,
);

const allowedOrigins = new Set(
  (
    process.env.CORS_ORIGINS ??
    "http://localhost:5173,http://localhost:3000"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const listResources = Object.freeze({
  teachers: "teachers",
  classes: "classes",
  classrooms: "classrooms",
});

const cache = new Map();

app.disable("x-powered-by");

app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
    maxAge: 86_400,
  }),
);

app.use(express.json({ limit: "10kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

for (const [routeName, upstreamPath] of Object.entries(listResources)) {
  app.get(
    `/api/${routeName}`,
    asyncRoute(async (_request, response) => {
      const { data, cacheStatus } = await withCache(
        `list:${upstreamPath}`,
        async () => {
          const upstreamResponse =
            await fetchFromJedlik(upstreamPath);

          const result = await upstreamResponse.json();

          if (!Array.isArray(result)) {
            throw new TypeError(
              "A Jedlik API válasza nem lista.",
            );
          }

          return result;
        },
      );

      response
        .set("X-Cache", cacheStatus)
        .set("Cache-Control", "public, max-age=60")
        .json(data);
    }),
  );
}

// GET /api/classmaster/09A
app.get(
  "/api/classmaster/:classCode",
  asyncRoute(async (request, response) => {
    const classCode = request.params.classCode.trim();

    if (!/^[\p{L}\p{N}_-]{1,20}$/u.test(classCode)) {
      throw new HttpError(
        400,
        "Érvénytelen osztálykód.",
      );
    }

    const { data, cacheStatus } = await withCache(
      `classmaster:${classCode}`,
      async () => {
        const upstreamResponse = await fetchFromJedlik(
          `classmaster/${encodeURIComponent(classCode)}`,
          {
            headers: {
              Accept: "text/plain",
            },
          },
        );

        return upstreamResponse.text();
      },
    );

    response
      .set("X-Cache", cacheStatus)
      .set("Cache-Control", "public, max-age=60")
      .type("text/plain; charset=utf-8")
      .send(data);
  }),
);

// POST /api/cards
//
// Példa body:
// {
//   "class": "11C",
//   "classroom": "",
//   "teacher": "",
//   "full": false,
//   "fromDate": "2026-09-01"
// }
app.post(
  "/api/cards",
  asyncRoute(async (request, response) => {
    const payload = validateCardsPayload(request.body);

    const upstreamResponse = await fetchFromJedlik(
      "cards",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    let data = await upstreamResponse.json();

    // A Jedlik API a cards eredményét jelenleg
    // JSON-szövegként adja vissza.
    if (typeof data === "string") {
      data = JSON.parse(data);
    }

    if (!isPlainObject(data)) {
      throw new TypeError(
        "A Jedlik cards válasza nem JSON objektum.",
      );
    }

    response
      .set("Cache-Control", "no-store")
      .json(data);
  }),
);

app.use((_request, response) => {
  response.status(404).json({
    error: "A végpont nem található.",
  });
});

app.use((error, _request, response, _next) => {
  if (error?.type === "entity.parse.failed") {
    response.status(400).json({
      error: "Érvénytelen JSON kéréstörzs.",
    });

    return;
  }

  if (error instanceof HttpError) {
    response.status(error.status).json({
      error: error.message,
    });

    return;
  }

  const isTimeout = [
    "AbortError",
    "TimeoutError",
  ].includes(error?.name);

  console.error(error);

  response.status(isTimeout ? 504 : 502).json({
    error: isTimeout
      ? "A Jedlik API nem válaszolt időben."
      : "A Jedlik API jelenleg nem érhető el.",
  });
});

app.listen(PORT, () => {
  console.log(
    `Jedlik proxy API: http://localhost:${PORT}`,
  );

  console.log(
    `Engedélyezett origin(ek): ${[
      ...allowedOrigins,
    ].join(", ")}`,
  );
});

async function fetchFromJedlik(
  resourcePath,
  options = {},
) {
  const upstreamResponse = await fetch(
    `${JEDLIK_API_BASE}/${resourcePath}`,
    {
      ...options,
      headers: {
        Accept: "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(
        UPSTREAM_TIMEOUT_MS,
      ),
    },
  );

  if (!upstreamResponse.ok) {
    throw new Error(
      `A Jedlik API ${upstreamResponse.status} ${upstreamResponse.statusText} választ adott.`,
    );
  }

  return upstreamResponse;
}

async function withCache(key, loader) {
  const cached = cache.get(key);

  if (
    cached &&
    Date.now() - cached.savedAt < CACHE_TTL_MS
  ) {
    return {
      data: cached.data,
      cacheStatus: "HIT",
    };
  }

  const data = await loader();

  cache.set(key, {
    data,
    savedAt: Date.now(),
  });

  return {
    data,
    cacheStatus: "MISS",
  };
}

function validateCardsPayload(body) {
  if (!isPlainObject(body)) {
    throw new HttpError(
      400,
      "A kérés törzsének JSON objektumnak kell lennie.",
    );
  }

  const payload = {
    class: readString(body.class, "class"),
    classroom: readString(
      body.classroom,
      "classroom",
    ),
    teacher: readString(body.teacher, "teacher"),
    full: body.full ?? false,
    fromDate: body.fromDate,
  };

  if (typeof payload.full !== "boolean") {
    throw new HttpError(
      400,
      "A full mezőnek boolean értéknek kell lennie.",
    );
  }

  if (!isValidIsoDate(payload.fromDate)) {
    throw new HttpError(
      400,
      "A fromDate mezőnek valós YYYY-MM-DD dátumnak kell lennie.",
    );
  }

  return payload;
}

function readString(value, fieldName) {
  const normalizedValue = value ?? "";

  if (
    typeof normalizedValue !== "string" ||
    normalizedValue.length > 50
  ) {
    throw new HttpError(
      400,
      `A ${fieldName} mező legfeljebb 50 karakteres szöveg lehet.`,
    );
  }

  return normalizedValue;
}

function isValidIsoDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const [year, month, day] = value
    .split("-")
    .map(Number);

  const date = new Date(
    Date.UTC(year, month - 1, day),
  );

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(
      handler(request, response, next),
    ).catch(next);
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : fallback;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}