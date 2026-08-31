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

const POLLING_INTERVAL_MS = 30 * 60_000;

const listResources = Object.freeze({
  teachers: "teachers",
  classes: "classes",
  classrooms: "classrooms",
});

const memoryStore = new Map();

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 1_000;
const MAX_REQUESTS_PER_WINDOW = 10;

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.startTime > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60_000);

async function refreshJedlikData() {
  console.log(`[${new Date().toISOString()}] Jedlik adatok frissítése a háttérben...`);

  for (const [routeName, upstreamPath] of Object.entries(listResources)) {
    try {
      const response = await fetchFromJedlik(upstreamPath);
      const data = await response.json();

      if (Array.isArray(data)) {
        memoryStore.set(`list:${routeName}`, {
          data,
          updatedAt: Date.now(),
        });
      }
    } catch (err) {
      console.error(`Hiba a(z) ${routeName} frissítésekor:`, err.message);
    }
  }

  const classesCache = memoryStore.get("list:classes");
  if (classesCache && Array.isArray(classesCache.data)) {
    for (const item of classesCache.data) {
      const classCode = typeof item === "string" ? item : item.code || item.name;
      if (!classCode) continue;

      try {
        const response = await fetchFromJedlik(
          `classmaster/${encodeURIComponent(classCode)}`,
          { headers: { Accept: "text/plain" } }
        );
        const textData = await response.text();

        memoryStore.set(`classmaster:${classCode}`, {
          data: textData,
          updatedAt: Date.now(),
        });
      } catch (err) {
      }
    }
  }

  console.log(`[${new Date().toISOString()}] Háttérfrissítés sikeresen befejeződött.`);
}

refreshJedlikData();
setInterval(refreshJedlikData, POLLING_INTERVAL_MS);

app.disable("x-powered-by");

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
    maxAge: 86_400,
  }),
);

app.use((request, response, next) => {
  const clientIp = request.ip || request.socket.remoteAddress || "unknown";
  const now = Date.now();

  const currentLimit = rateLimitMap.get(clientIp) || {
    count: 0,
    startTime: now,
  };

  if (now - currentLimit.startTime > RATE_LIMIT_WINDOW_MS) {
    currentLimit.count = 1;
    currentLimit.startTime = now;
  } else {
    currentLimit.count += 1;
  }

  rateLimitMap.set(clientIp, currentLimit);

  if (currentLimit.count > MAX_REQUESTS_PER_WINDOW) {
    response.status(429).json({
      error: "Túl sok kérés. A megengedett limit: 2 kérés / másodperc.",
    });
    return;
  }

  next();
});

app.use(express.json({ limit: "10kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ 
    status: "ok",
    cachedKeys: memoryStore.size 
  });
});

for (const routeName of Object.keys(listResources)) {
  app.get(`/api/${routeName}`, (_request, response) => {
    const cached = memoryStore.get(`list:${routeName}`);

    if (!cached) {
      response.status(503).json({
        error: "Az adatok jelenleg inicializálás alatt állnak. Próbáld újra pár másodperc múlva.",
      });
      return;
    }

    response
      .set("X-Cache", "HIT-MEMORY")
      .set("Cache-Control", "public, max-age=120")
      .json(cached.data);
  });
}

app.get(
  "/api/classmaster/:classCode",
  asyncRoute(async (request, response) => {
    const classCode = request.params.classCode.trim();

    if (!/^[\p{L}\p{N}_-]{1,20}$/u.test(classCode)) {
      throw new HttpError(400, "Érvénytelen osztálykód.");
    }

    let cached = memoryStore.get(`classmaster:${classCode}`);

    if (!cached) {
      const upstreamResponse = await fetchFromJedlik(
        `classmaster/${encodeURIComponent(classCode)}`,
        { headers: { Accept: "text/plain" } }
      );
      const textData = await upstreamResponse.text();
      
      cached = { data: textData, updatedAt: Date.now() };
      memoryStore.set(`classmaster:${classCode}`, cached);
    }

    response
      .set("X-Cache", "HIT-MEMORY")
      .set("Cache-Control", "public, max-age=120")
      .type("text/plain; charset=utf-8")
      .send(cached.data);
  }),
);

app.post(
  "/api/cards",
  asyncRoute(async (request, response) => {
    const payload = validateCardsPayload(request.body);

    const upstreamResponse = await fetchFromJedlik("cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let data = await upstreamResponse.json();

    if (typeof data === "string") {
      data = JSON.parse(data);
    }

    if (!isPlainObject(data)) {
      throw new TypeError("A Jedlik cards válasza nem JSON objektum.");
    }

    response
      .set("Cache-Control", "no-store")
      .json(data);
  }),
);

app.use((_request, response) => {
  response.status(404).json({ error: "A végpont nem található." });
});

app.use((error, _request, response, _next) => {
  if (error?.type === "entity.parse.failed") {
    response.status(400).json({ error: "Érvénytelen JSON kéréstörzs." });
    return;
  }

  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message });
    return;
  }

  const isTimeout = ["AbortError", "TimeoutError"].includes(error?.name);
  console.error(error);

  response.status(isTimeout ? 504 : 502).json({
    error: isTimeout
      ? "A Jedlik API nem válaszolt időben."
      : "A Jedlik API jelenleg nem érhető el.",
  });
});

app.listen(PORT, () => {
  console.log(`Jedlik proxy API: http://localhost:${PORT}`);
  console.log("CORS: Minden origin (*)");
  console.log("Rate limit: 10 kérés / másodperc");
  console.log("Cache stratégia: Háttérbeli frissítés 30 percenként (Memory-First)");
});

async function fetchFromJedlik(resourcePath, options = {}) {
  const upstreamResponse = await fetch(`${JEDLIK_API_BASE}/${resourcePath}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!upstreamResponse.ok) {
    throw new Error(
      `A Jedlik API ${upstreamResponse.status} ${upstreamResponse.statusText} választ adott.`
    );
  }

  return upstreamResponse;
}

function validateCardsPayload(body) {
  if (!isPlainObject(body)) {
    throw new HttpError(400, "A kérés törzsének JSON objektumnak kell lennie.");
  }

  const payload = {
    class: readString(body.class, "class"),
    classroom: readString(body.classroom, "classroom"),
    teacher: readString(body.teacher, "teacher"),
    full: body.full ?? false,
    fromDate: body.fromDate,
  };

  if (typeof payload.full !== "boolean") {
    throw new HttpError(400, "A full mezőnek boolean értéknek kell lennie.");
  }

  if (!isValidIsoDate(payload.fromDate)) {
    throw new HttpError(400, "A fromDate mezőnek valós YYYY-MM-DD dátumnak kell lennie.");
  }

  return payload;
}

function readString(value, fieldName) {
  const normalizedValue = value ?? "";
  if (typeof normalizedValue !== "string" || normalizedValue.length > 50) {
    throw new HttpError(400, `A ${fieldName} mező legfeljebb 50 karakteres szöveg lehet.`);
  }
  return normalizedValue;
}

function isValidIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}