import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../netlify/functions/student-report.mjs';

const environmentKeys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TEACHER_REPORT_TOKEN'];

function setReportEnvironment(t, values = {}) {
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  for (const key of environmentKeys) process.env[key] = values[key] || '';
  t.after(() => {
    for (const key of environmentKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

function mockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test('does not expose a report before private Netlify settings exist', async (t) => {
  setReportEnvironment(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Fetch must not be called for an unconfigured report.');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await handler({ httpMethod: 'GET', headers: {} });

  assert.equal(result.statusCode, 503);
  assert.match(JSON.parse(result.body).error, /no está configurado/i);
});

test('rejects an incorrect teacher token before contacting Supabase', async (t) => {
  const token = 'a'.repeat(40);
  setReportEnvironment(t, {
    SUPABASE_URL: 'https://project.example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
    TEACHER_REPORT_TOKEN: token
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Fetch must not be called for an invalid token.');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await handler({
    httpMethod: 'GET',
    headers: { authorization: `Bearer ${'b'.repeat(40)}` }
  });

  assert.equal(result.statusCode, 401);
});

test('returns only usernames and saved progress, never auth emails or IDs', async (t) => {
  const token = 'a'.repeat(40);
  setReportEnvironment(t, {
    SUPABASE_URL: 'https://project.example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
    TEACHER_REPORT_TOKEN: token
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v1/admin/users')) {
      return mockResponse({
        users: [{
          id: 'private-user-id',
          email: 'private@example.com',
          user_metadata: { username: 'Ana' }
        }]
      });
    }
    if (String(url).includes('/rest/v1/student_profiles')) {
      return mockResponse([{
        user_id: 'private-user-id',
        grade: 4,
        grade_data: {
          '4': {
            missions: {
              '2': {
                evidence: { answer: 'Respuesta' }
              }
            }
          }
        },
        updated_at: '2026-11-15T12:00:00Z'
      }]);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await handler({
    httpMethod: 'GET',
    headers: { authorization: `Bearer ${token}` }
  });
  const payload = JSON.parse(result.body);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(payload.students[0], {
    username: 'Ana',
    grade: 4,
    gradeData: {
      '4': {
        missions: {
          '2': {
            evidence: { answer: 'Respuesta' }
          }
        }
      }
    },
    updatedAt: '2026-11-15T12:00:00Z'
  });
  assert.equal(JSON.stringify(payload).includes('private@example.com'), false);
  assert.equal(JSON.stringify(payload).includes('private-user-id'), false);
});
