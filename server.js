import { createServer } from 'node:http';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scryptAsync = promisify(scrypt);
const root = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(root, 'data');
mkdirSync(dataDirectory, { recursive: true });

const database = new DatabaseSync(join(dataDirectory, 'lectomente.sqlite'));
database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    completed_challenges TEXT NOT NULL DEFAULT '[]',
    progress TEXT NOT NULL DEFAULT '{}',
    grade INTEGER CHECK (grade IS NULL OR grade IN (4, 5)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`);
const studentColumns = database.prepare('PRAGMA table_info(students)').all();
if (!studentColumns.some((column) => column.name === 'grade')) {
  database.exec('ALTER TABLE students ADD COLUMN grade INTEGER CHECK (grade IS NULL OR grade IN (4, 5))');
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');

  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (['POST', 'PUT', 'DELETE'].includes(request.method || '') && request.headers.origin) {
        const requestOrigin = new URL(request.headers.origin).origin;
        if (requestOrigin !== url.origin) {
          sendJson(response, 403, { error: 'Origen de solicitud no permitido.' });
          return;
        }
      }
      await handleApi(request, response, url.pathname);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      sendJson(response, 405, { error: 'Método no permitido.' });
      return;
    }

    const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const fileName = requestedPath.slice(1);
    if (!['index.html', 'reto.html', 'styles.css', 'auth.js', 'supabase-config.js'].includes(fileName)) {
      sendJson(response, 404, { error: 'Página no encontrada.' });
      return;
    }

    const contents = await readFile(join(root, fileName));
    response.writeHead(200, {
      'Content-Type': {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8'
      }[extname(fileName)],
      'Cache-Control': 'no-store'
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    console.error('Error al atender la solicitud:', error);
    if (!response.headersSent) sendJson(response, 500, { error: 'Ocurrió un error en el servidor.' });
    else response.end();
  }
});

async function handleApi(request, response, pathname) {
  if (pathname === '/api/session' && request.method === 'GET') {
    const student = getSessionStudent(request);
    sendJson(response, 200, { user: student });
    return;
  }

  if (pathname === '/api/register' && request.method === 'POST') {
    const body = await readJson(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const password = body.password;
    if (name.length < 2 || name.length > 60) {
      sendJson(response, 400, { error: 'El nombre debe tener entre 2 y 60 caracteres.' });
      return;
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      sendJson(response, 400, { error: 'La contraseña debe tener entre 8 y 128 caracteres.' });
      return;
    }

    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await scryptAsync(password, salt, 64)).toString('hex');
    const result = database.prepare(`
        INSERT INTO students (name, name_key, password_salt, password_hash)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name_key) DO NOTHING
      `).run(name, name.toLocaleLowerCase('es'), salt, passwordHash);
    if (result.changes === 0) {
      sendJson(response, 409, { error: 'Ya existe una cuenta con ese nombre. Inicia sesión o elige otro.' });
      return;
    }
    const studentId = Number(result.lastInsertRowid);
    await createSession(studentId, response);
    sendJson(response, 201, { user: getStudent(studentId) });
    return;
  }

  if (pathname === '/api/login' && request.method === 'POST') {
    const body = await readJson(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const row = database.prepare('SELECT * FROM students WHERE name_key = ?')
      .get(name.toLocaleLowerCase('es'));
    if (!row || password.length > 128) {
      sendJson(response, 401, { error: 'Nombre o contraseña incorrectos.' });
      return;
    }

    const passwordHash = (await scryptAsync(password, row.password_salt, 64)).toString('hex');
    if (!timingSafeEqual(Buffer.from(passwordHash, 'hex'), Buffer.from(row.password_hash, 'hex'))) {
      sendJson(response, 401, { error: 'Nombre o contraseña incorrectos.' });
      return;
    }
    await createSession(row.id, response);
    sendJson(response, 200, { user: getStudent(row.id) });
    return;
  }

  if (pathname === '/api/logout' && request.method === 'POST') {
    const token = readCookie(request, 'lectomente_session');
    if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    response.setHeader('Set-Cookie', `lectomente_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname === '/api/grade' && request.method === 'PUT') {
    const student = getSessionStudent(request);
    if (!student) {
      sendJson(response, 401, { error: 'Inicia sesión para guardar tu grado.' });
      return;
    }
    const body = await readJson(request);
    if (body.grade !== 4 && body.grade !== 5) {
      sendJson(response, 400, { error: 'Selecciona cuarto o quinto grado.' });
      return;
    }
    database.prepare('UPDATE students SET grade = ? WHERE id = ?').run(body.grade, student.id);
    sendJson(response, 200, { user: getStudent(student.id) });
    return;
  }

  if (pathname === '/api/progress' && request.method === 'PUT') {
    const student = getSessionStudent(request);
    if (!student) {
      sendJson(response, 401, { error: 'Inicia sesión para guardar tu progreso.' });
      return;
    }
    const body = await readJson(request);
    if (!Number.isInteger(body.points) || body.points < 0 || body.points > 1000000
      || !Array.isArray(body.completedChallenges)
      || body.completedChallenges.some((item) => !Number.isInteger(item) || item < 1 || item > 5)
      || !body.progress || typeof body.progress !== 'object' || Array.isArray(body.progress)) {
      sendJson(response, 400, { error: 'Los datos de progreso no son válidos.' });
      return;
    }
    database.prepare(`
      UPDATE students
      SET points = ?, completed_challenges = ?, progress = ?
      WHERE id = ?
    `).run(
      body.points,
      JSON.stringify([...new Set(body.completedChallenges)]),
      JSON.stringify(body.progress),
      student.id
    );
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname.startsWith('/api/')) {
    response.setHeader('Allow', 'GET, POST, PUT');
    sendJson(response, 405, { error: 'Ruta o método de API no permitido.' });
    return;
  }
  sendJson(response, 404, { error: 'Ruta no encontrada.' });
}

function getSessionStudent(request) {
  const token = readCookie(request, 'lectomente_session');
  if (!token) return null;
  const session = database.prepare(`
    SELECT student_id FROM sessions
    WHERE token_hash = ? AND expires_at > ?
  `).get(hashToken(token), Date.now());
  if (!session) return null;
  return getStudent(session.student_id);
}

function getStudent(id) {
  const row = database.prepare(`
    SELECT id, name, points, completed_challenges, progress, grade
    FROM students WHERE id = ?
  `).get(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    points: row.points,
    completedChallenges: JSON.parse(row.completed_challenges),
    progress: JSON.parse(row.progress),
    grade: row.grade
  };
}

async function createSession(studentId, response) {
  database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  database.prepare('INSERT INTO sessions (token_hash, student_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), studentId, expiresAt);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `lectomente_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`);
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function readCookie(request, name) {
  const cookieHeader = request.headers.cookie || '';
  const prefix = `${name}=`;
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return cookie ? cookie.slice(prefix.length) : '';
}

async function readJson(request) {
  if (!request.headers['content-type']?.includes('application/json')) {
    throw new Error('La solicitud debe usar application/json.');
  }
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (data.length > 65536) throw new Error('La solicitud supera el tamaño permitido.');
  }
  try {
    return JSON.parse(data);
  } catch {
    throw new Error('El cuerpo de la solicitud no contiene JSON válido.');
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`LectoMente disponible en http://localhost:${port}`);
});
