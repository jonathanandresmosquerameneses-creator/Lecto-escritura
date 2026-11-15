# LectoMente

## Preparar Supabase

1. En Supabase, abre **SQL Editor**, crea una consulta nueva, copia el contenido de `supabase-schema.sql` y pulsa **Run**. Esto crea la tabla de perfiles y las reglas que limitan cada fila al estudiante propietario.
2. En **Authentication → Providers → Email**, desactiva **Confirm email**. La aplicación permite entrar con usuario y contraseña, sin pedir correo personal; Supabase usa un alias interno para cada usuario. Si olvidas la contraseña, un docente o administrador deberá ayudarte; no hay recuperación automática por correo.
3. En **Project Settings → API Keys** (o **Connect**), copia la **Project URL** y la clave pública **anon/publishable**. En `supabase-config.js`, reemplaza `TU_PROJECT_URL` y `TU_CLAVE_PUBLICA_ANON`. La URL y esa clave pública se usan en el navegador; nunca pongas la clave `service_role` en ese archivo.

La clave pública no reemplaza las políticas RLS. Mantén habilitada la seguridad por filas y no elimines las políticas del SQL.

## Consultar y descargar el progreso docente

El panel privado está en `docente.html` y solo consulta datos: no cambia cuentas, contraseñas ni progreso. Para habilitarlo en Netlify, abre **Site configuration → Environment variables** y configura:

- `SUPABASE_URL`: la URL del proyecto Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: la clave `service_role` de Supabase. Guárdala únicamente como variable privada de Netlify; nunca la pongas en archivos del sitio, GitHub ni en el navegador.
- `TEACHER_REPORT_TOKEN`: una clave aleatoria de al menos 32 caracteres. No uses una contraseña de estudiante ni la compartas.

Después de guardar las variables, vuelve a desplegar el sitio. Abre `docente.html`, introduce la clave `TEACHER_REPORT_TOKEN` y consulta o descarga el CSV. El reporte incluye nombres de usuario, grado, estado de cada reto y las respuestas guardadas por las actividades; no incluye correos ni contraseñas. El CSV contiene información académica privada: guárdalo en un dispositivo seguro y no lo compartas públicamente.

Para desarrollo local, `npm start` sirve la página estática, pero no ejecuta la Netlify Function protegida. El panel de informes debe usarse en el sitio desplegado en Netlify.

## Publicar con GitHub y Netlify

1. Sube el proyecto a GitHub, incluyendo `supabase-schema.sql`, `netlify.toml` y `supabase-config.js`. `.gitignore` excluye la base de datos local.
2. En Netlify, importa el repositorio de GitHub. La configuración de `netlify.toml` publica la carpeta raíz; no se requiere comando de compilación.
3. Cuando Netlify asigne una URL al sitio, agrégala en Supabase, en **Authentication → URL Configuration → Site URL** y en las direcciones permitidas de redirección.
4. Abre la URL del sitio y prueba crear una cuenta, elegir cada grado, completar una actividad y volver a entrar para confirmar que el progreso sigue guardado.

## Ejecutar localmente

Se requiere Node.js 22.13 o posterior. Después de configurar `supabase-config.js`, ejecuta:

```powershell
npm start
```

Abre `http://localhost:3000`. También puedes servir la carpeta con otro servidor HTTP local. No abras los archivos HTML directamente.

El grado y el progreso se guardan en Supabase, aislados por cuenta y por grado. El audio de cuarto usa una narración original del navegador y también admite un archivo autorizado del docente desde el dispositivo.

Los cinco retos se desbloquean en orden y cada uno conserva su propio avance. El progreso anterior de la primera misión se reconoce como el reto 1; los nuevos retos se agregan sin borrar esos datos ni requieren cambios en `supabase-schema.sql`.
