# Jedlik timetable proxy API

Express alapú proxy a Jedlik órarend publikus listáihoz. A böngésző a saját
API-t hívja, a külső Jedlik API-t pedig a Node.js szerver éri el.

## Indítás

Node.js 18 vagy újabb szükséges.

```bash
npm install
cp .env.example .env
npm run dev
```

Alapértelmezetten a szerver a `http://localhost:3001` címen indul. A `.env`
fájlban add meg a frontend pontos originjét. Több origin vesszővel választható
el:

```env
CORS_ORIGINS=http://localhost:5173,https://sajat-frontend.hu
```

## Saját végpontok

| Metódus | Végpont | Tartalom |
| --- | --- | --- |
| GET | `/api/teachers` | Tanárok |
| GET | `/api/classes` | Osztályok |
| GET | `/api/classrooms` | Osztálytermek |
| GET | `/api/health` | Állapotellenőrzés |

Példa:

```js
const response = await fetch("http://localhost:3001/api/teachers");

if (!response.ok) {
  throw new Error("Nem sikerült lekérni a tanárokat.");
}

const teachers = await response.json();
```

Az API öt percig memóriában gyorsítótárazza a Jedlik válaszait. A
`CACHE_TTL_MS` környezeti változóval ez módosítható. A cache a szerver
újraindításakor kiürül.

## Production

- A `CORS_ORIGINS` értékében csak a valódi frontend domaineket engedélyezd.
- A frontenden az API alapcímét környezeti változóban kezeld.
- A Node szervert HTTPS-t biztosító platform vagy reverse proxy mögött futtasd.
