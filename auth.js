(() => {
  let client;
  let currentProfile;
  let saveQueue = Promise.resolve();

  function getClient() {
    const config = window.LECTOMENTE_SUPABASE_CONFIG;
    if (!window.supabase || !config || !config.url || !config.anonKey
      || config.url.includes('TU_PROJECT_URL') || config.anonKey.includes('TU_CLAVE_PUBLICA')) {
      throw new Error('Configura la URL y la clave pública de Supabase en supabase-config.js.');
    }
    if (!client) client = window.supabase.createClient(config.url, config.anonKey);
    return client;
  }

  function normalizeName(name) {
    return typeof name === 'string' ? name.trim().normalize('NFC').toLocaleLowerCase('es') : '';
  }

  async function usernameEmail(name) {
    const normalizedName = normalizeName(name);
    if (normalizedName.length < 2 || normalizedName.length > 60) {
      throw new Error('El usuario debe tener entre 2 y 60 caracteres.');
    }
    const bytes = new TextEncoder().encode(normalizedName);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    const usernameHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `${usernameHash}@users.example.com`;
  }

  function toStudent(user, profile) {
    currentProfile = profile || {
      user_id: user.id,
      grade: null,
      grade_data: {}
    };
    const metadataName = user.user_metadata && user.user_metadata.username;
    return {
      id: user.id,
      name: metadataName || 'Estudiante',
      grade: currentProfile.grade,
      gradeData: currentProfile.grade_data || {}
    };
  }

  async function loadProfile(user) {
    const { data, error } = await getClient()
      .from('student_profiles')
      .select('user_id, grade, grade_data')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) throw new Error(`No se pudo cargar tu perfil: ${error.message}`);
    return toStudent(user, data);
  }

  async function persistProfile() {
    const { data, error } = await getClient()
      .from('student_profiles')
      .upsert(currentProfile, { onConflict: 'user_id' })
      .select('user_id, grade, grade_data')
      .single();
    if (error) throw new Error(`No se pudo guardar tu progreso: ${error.message}`);
    currentProfile = data;
    return data;
  }

  window.LectoMente = {
    async session() {
      const { data, error } = await getClient().auth.getSession();
      if (error) throw new Error(`No se pudo comprobar la sesión: ${error.message}`);
      if (!data.session) {
        currentProfile = null;
        return null;
      }
      return loadProfile(data.session.user);
    },
    async register(name, password) {
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        throw new Error('La contraseña debe tener entre 8 y 128 caracteres.');
      }
      const email = await usernameEmail(name);
      const normalizedName = name.trim();
      const { data, error } = await getClient().auth.signUp({
        email,
        password,
        options: { data: { username: normalizedName } }
      });
      if (error) throw new Error(error.message);
      if (!data.session || !data.user) {
        throw new Error('Para usar cuentas con usuario, desactiva la confirmación de correo en Supabase: Authentication → Providers → Email → Confirm email. No se solicita correo personal.');
      }
      const profile = toStudent(data.user, null);
      await persistProfile();
      return { ...profile, gradeData: currentProfile.grade_data };
    },
    async login(name, password) {
      const email = await usernameEmail(name);
      const { data, error } = await getClient().auth.signInWithPassword({ email, password });
      if (error) throw new Error('Usuario o contraseña incorrectos.');
      return loadProfile(data.user);
    },
    async logout() {
      const { error } = await getClient().auth.signOut();
      if (error) throw new Error(`No se pudo cerrar la sesión: ${error.message}`);
      currentProfile = null;
    },
    async setGrade(grade) {
      if (grade !== 4 && grade !== 5) throw new Error('Selecciona cuarto o quinto grado.');
      const { data, error } = await getClient().auth.getUser();
      if (error || !data.user) throw new Error('Inicia sesión para guardar tu grado.');
      if (!currentProfile || currentProfile.user_id !== data.user.id) {
        await loadProfile(data.user);
      }
      currentProfile.grade = grade;
      currentProfile.grade_data = currentProfile.grade_data || {};
      const savedProfile = await persistProfile();
      return toStudent(data.user, savedProfile);
    },
    async saveProgress(progress) {
      const save = async () => {
        const { data, error } = await getClient().auth.getUser();
        if (error || !data.user || !currentProfile || currentProfile.user_id !== data.user.id) {
          throw new Error('La sesión expiró. Inicia sesión de nuevo para guardar el progreso.');
        }
        if (currentProfile.grade !== progress.grade) {
          throw new Error('El grado de la sesión cambió. Vuelve a elegir tu grado antes de guardar.');
        }
        const gradeData = currentProfile.grade_data || {};
        gradeData[String(progress.grade)] = {
          points: progress.points,
          completedChallenges: progress.completedChallenges,
          mission: progress.mission
        };
        currentProfile.grade_data = gradeData;
        await persistProfile();
      };
      const pendingSave = saveQueue.then(save);
      saveQueue = pendingSave.catch(() => {});
      return pendingSave;
    },
    requireSession() {
      return this.session().then((user) => {
        if (!user) window.location.replace('index.html?login=required');
        return user;
      });
    }
  };
})();
