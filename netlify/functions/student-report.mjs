import { timingSafeEqual } from 'node:crypto';

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    },
    body: JSON.stringify(body)
  };
}

function getConfiguration() {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const reportToken = process.env.TEACHER_REPORT_TOKEN;
  if (!supabaseUrl || !serviceRoleKey || !reportToken || reportToken.length < 32) return null;

  try {
    const parsedUrl = new URL(supabaseUrl);
    if (parsedUrl.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  return { supabaseUrl, serviceRoleKey, reportToken };
}

function hasValidToken(authorization, expectedToken) {
  const match = /^Bearer\s+(.+)$/i.exec(authorization || '');
  if (!match || match[1].length > 256) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function fetchSupabaseJson(url, serviceRoleKey, extraHeaders = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...extraHeaders
    }
  });
  if (!response.ok) throw new Error(`Supabase API returned ${response.status}.`);
  return response.json();
}

async function getAllAuthUsers(supabaseUrl, serviceRoleKey) {
  const users = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${PAGE_SIZE}`;
    const result = await fetchSupabaseJson(url, serviceRoleKey);
    if (!result || !Array.isArray(result.users)) {
      throw new Error('Supabase returned an invalid user list.');
    }
    users.push(...result.users);
    if (result.users.length < PAGE_SIZE) return users;
  }
  throw new Error('The student list exceeded the report page limit.');
}

async function getAllProfiles(supabaseUrl, serviceRoleKey) {
  const profiles = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * PAGE_SIZE;
    const end = start + PAGE_SIZE - 1;
    const url = `${supabaseUrl}/rest/v1/student_profiles?select=user_id,grade,grade_data,updated_at`;
    const result = await fetchSupabaseJson(url, serviceRoleKey, {
      'Range-Unit': 'items',
      Range: `${start}-${end}`
    });
    if (!Array.isArray(result)) throw new Error('Supabase returned an invalid profile list.');
    profiles.push(...result);
    if (result.length < PAGE_SIZE) return profiles;
  }
  throw new Error('The profile list exceeded the report page limit.');
}

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    const result = jsonResponse(405, { error: 'Método no permitido.' });
    result.headers.Allow = 'GET';
    return result;
  }

  const configuration = getConfiguration();
  if (!configuration) {
    return jsonResponse(503, { error: 'El panel docente aún no está configurado en Netlify.' });
  }
  if (!hasValidToken(event.headers?.authorization || event.headers?.Authorization, configuration.reportToken)) {
    return jsonResponse(401, { error: 'La clave docente no es válida.' });
  }

  try {
    const [users, profiles] = await Promise.all([
      getAllAuthUsers(configuration.supabaseUrl, configuration.serviceRoleKey),
      getAllProfiles(configuration.supabaseUrl, configuration.serviceRoleKey)
    ]);
    const profilesByUserId = new Map(profiles.map((profile) => [profile.user_id, profile]));
    const students = users.flatMap((user) => {
      const username = user.user_metadata?.username;
      if (typeof username !== 'string' || !username.trim()) return [];
      const profile = profilesByUserId.get(user.id);
      return [{
        username: username.trim(),
        grade: profile?.grade ?? null,
        gradeData: profile?.grade_data && typeof profile.grade_data === 'object'
          ? profile.grade_data
          : {},
        updatedAt: profile?.updated_at ?? null
      }];
    });
    students.sort((left, right) => left.username.localeCompare(right.username, 'es'));
    return jsonResponse(200, { students });
  } catch (error) {
    console.error('No se pudo generar el informe docente:', error);
    return jsonResponse(502, { error: 'No se pudo consultar el progreso. Revisa la configuración privada de Netlify y la conexión con Supabase.' });
  }
}
