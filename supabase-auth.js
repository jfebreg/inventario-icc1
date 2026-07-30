(function () {
  const nativeFetch = window.fetch.bind(window);
  const auth = {
    ready: false,
    configured: false,
    migrationComplete: false,
    bootstrapUsed: false,
    config: null,
    client: null,
    session: null,
    profile: null,
    tasks: [],
    notifications: [],
    realtimeChannel: null,
    idleTimer: null,
    idleWarningTimer: null,
    lastActivityAt: Date.now(),
    idleExpiring: false,
    passwordSetup: /(?:\?|&)auth=(?:invite|recovery)/.test(location.search) || /type=(?:invite|recovery)/.test(location.hash),
    onChange: null
  };

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function idleMinutes() {
    const configured = Number(auth.config?.authIdleMinutes || 30);
    return Math.min(480, Math.max(10, Number.isFinite(configured) ? configured : 30));
  }

  function clearIdleTimers() {
    clearTimeout(auth.idleTimer);
    clearTimeout(auth.idleWarningTimer);
    auth.idleTimer = null;
    auth.idleWarningTimer = null;
  }

  async function expireIdleSession() {
    if (!auth.session || auth.idleExpiring) return;
    auth.idleExpiring = true;
    clearIdleTimers();
    try {
      await auth.client?.auth.signOut({ scope: "local" });
    } finally {
      auth.session = null;
      auth.profile = null;
      auth.idleExpiring = false;
      await clearRealtime();
      if (typeof auth.onChange === "function") auth.onChange(null);
      window.dispatchEvent(new CustomEvent("icc-session-expired", {
        detail: "La sesión se cerró por inactividad. Ingresa nuevamente."
      }));
    }
  }

  function scheduleIdleTimers(preserveActivity = false) {
    clearIdleTimers();
    if (!auth.session) return;
    if (!preserveActivity) auth.lastActivityAt = Date.now();
    const timeoutMs = idleMinutes() * 60 * 1000;
    const remainingMs = timeoutMs - (Date.now() - auth.lastActivityAt);
    if (remainingMs <= 0) {
      expireIdleSession();
      return;
    }
    const warningMinutes = Math.min(5, Math.max(1, Math.floor(idleMinutes() / 3)));
    const warningDelay = remainingMs - warningMinutes * 60 * 1000;
    if (warningDelay > 0) {
      auth.idleWarningTimer = setTimeout(() => {
        window.dispatchEvent(new CustomEvent("icc-session-warning", {
          detail: `La sesión se cerrará en ${warningMinutes} minuto(s) si no registras actividad.`
        }));
      }, warningDelay);
    }
    auth.idleTimer = setTimeout(expireIdleSession, remainingMs);
  }

  function registerUserActivity() {
    if (!auth.session || auth.idleExpiring) return;
    const now = Date.now();
    if (now - auth.lastActivityAt < 1000) return;
    auth.lastActivityAt = now;
    scheduleIdleTimers(true);
  }

  ["pointerdown", "keydown", "touchstart"].forEach(type =>
    window.addEventListener(type, registerUserActivity, { passive: true })
  );
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && auth.session) scheduleIdleTimers(true);
  });

  async function apiFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input.url;
    const sameOriginApi = String(url || "").startsWith("/api/") || String(url || "").startsWith(location.origin + "/api/");
    if (!sameOriginApi) return nativeFetch(input, init);
    const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined) || {});
    if (auth.session?.access_token) headers.set("Authorization", `Bearer ${auth.session.access_token}`);
    else {
      const legacyUserId = localStorage.getItem("control-activos-session") || localStorage.getItem("control-activos-user") || "";
      if (legacyUserId) headers.set("X-Legacy-User-Id", legacyUserId);
    }
    return nativeFetch(input, { ...init, headers });
  }

  window.fetch = apiFetch;

  function appUser() {
    if (!auth.profile) return null;
    return {
      id: auth.profile.legacy_user_id || auth.profile.id,
      profileId: auth.profile.id,
      authUserId: auth.profile.auth_user_id,
      name: auth.profile.name,
      email: auth.profile.email,
      initials: auth.profile.initials || "US",
      role: auth.profile.role || "Usuario",
      costCenter: auth.profile.cost_center || "Bodega Central",
      admin: Boolean(auth.profile.admin),
      permissions: Array.isArray(auth.profile.permissions) ? auth.profile.permissions : [],
      active: auth.profile.active !== false
    };
  }

  async function loadProfile() {
    if (!auth.session) {
      auth.profile = null;
      return null;
    }
    const response = await apiFetch("/api/session/profile");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "No se pudo cargar el perfil.");
    auth.profile = payload.profile;
    auth.migrationComplete = Boolean(payload.migrationComplete);
    return auth.profile;
  }

  async function refreshRealtime() {
    if (!auth.session || !auth.profile) return;
    const [tasksResponse, notificationsResponse] = await Promise.all([
      apiFetch("/api/tasks"),
      apiFetch("/api/notifications")
    ]);
    const tasksPayload = await tasksResponse.json().catch(() => ({}));
    const notificationsPayload = await notificationsResponse.json().catch(() => ({}));
    if (tasksResponse.ok) auth.tasks = tasksPayload.tasks || [];
    if (notificationsResponse.ok) auth.notifications = notificationsPayload.notifications || [];
    window.dispatchEvent(new CustomEvent("icc-realtime", { detail: { tasks: auth.tasks, notifications: auth.notifications } }));
  }

  function subscribeRealtime() {
    if (!auth.client || !auth.session || auth.realtimeChannel) return;
    auth.realtimeChannel = auth.client
      .channel(`icc-operacion-${auth.session.user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "inventory_tasks" }, refreshRealtime)
      .on("postgres_changes", { event: "*", schema: "public", table: "inventory_notifications" }, refreshRealtime)
      .subscribe();
    refreshRealtime().catch(() => {});
  }

  async function clearRealtime() {
    if (auth.client && auth.realtimeChannel) await auth.client.removeChannel(auth.realtimeChannel);
    auth.realtimeChannel = null;
    auth.tasks = [];
    auth.notifications = [];
  }

  async function handleSession(session, notify = true) {
    auth.session = session || null;
    if (!auth.session) {
      auth.profile = null;
      await clearRealtime();
    } else if (!auth.passwordSetup) {
      await loadProfile();
      subscribeRealtime();
    }
    if (auth.session) scheduleIdleTimers();
    else clearIdleTimers();
    if (notify && typeof auth.onChange === "function") auth.onChange(appUser());
  }

  async function init(onChange) {
    auth.onChange = onChange;
    try {
      const response = await nativeFetch("/api/public-config", { cache: "no-store" });
      auth.config = await response.json();
      auth.configured = Boolean(auth.config.authConfigured && window.supabase?.createClient);
      auth.migrationComplete = Boolean(auth.config.migrationComplete);
      auth.bootstrapUsed = Boolean(auth.config.bootstrapUsed);
      if (auth.configured) {
        auth.client = window.supabase.createClient(auth.config.supabaseUrl, auth.config.supabasePublishableKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
        });
        const { data } = await auth.client.auth.getSession();
        auth.session = data.session || null;
        if (auth.session && !auth.passwordSetup) {
          await loadProfile();
          subscribeRealtime();
          scheduleIdleTimers();
        }
        auth.client.auth.onAuthStateChange((_event, session) => {
          setTimeout(() => handleSession(session).catch(error => window.dispatchEvent(new CustomEvent("icc-auth-error", { detail: error.message }))), 0);
        });
      }
    } catch (error) {
      console.error("No se pudo inicializar Supabase Auth:", error);
    } finally {
      auth.ready = true;
      if (typeof auth.onChange === "function") auth.onChange(appUser());
      window.dispatchEvent(new CustomEvent("icc-auth-ready"));
    }
  }

  function loginMarkup(legacyMarkup = "") {
    if (!auth.ready) return `<div class="card auth-card"><h1 class="page-title">Preparando acceso seguro…</h1><p class="page-subtitle">Conectando con Supabase.</p></div>`;
    if (!auth.configured) return legacyMarkup;
    if (auth.passwordSetup && auth.session) {
      return `<div class="card auth-card"><p class="eyebrow">Activación segura</p><h1 class="page-title">Crear contraseña</h1><p class="page-subtitle">Define una contraseña de al menos 8 caracteres para completar tu cuenta.</p>
        <form id="authPasswordForm"><label>Nueva contraseña<input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
        <label style="margin-top:14px">Repetir contraseña<input name="confirmation" type="password" minlength="8" autocomplete="new-password" required></label>
        <div class="form-actions"><button class="button">Guardar contraseña y entrar</button></div></form></div>`;
    }
    const bootstrap = !auth.migrationComplete
      ? `<div class="auth-separator"><span>Activación inicial</span></div>
        <form id="authBootstrapForm"><p class="page-subtitle">Administrador inicial: <strong>${esc(auth.config.initialAdmin?.name)}</strong> · ${esc(auth.config.initialAdmin?.email)}</p>
        <label>Código de activación de Render<input name="token" type="password" required></label>
        <div class="form-actions"><button class="button secondary">Enviar invitación a Julio</button></div></form>`
      : "";
    return `<div class="card auth-card"><p class="eyebrow">Acceso protegido</p><h1 class="page-title">Ingreso al sistema</h1>
      <p class="page-subtitle">Ingresa con el correo y contraseña configurados en Supabase.</p>
      <form id="authLoginForm"><label>Correo<input name="email" type="email" autocomplete="username" required></label>
      <label style="margin-top:14px">Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
      <div class="form-actions auth-actions"><button type="button" class="link-button" id="authForgotButton">Recuperar contraseña</button><button class="button">Entrar</button></div></form>
      ${bootstrap}${!auth.migrationComplete ? legacyMarkup : ""}</div>`;
  }

  async function logout() {
    clearIdleTimers();
    if (auth.client) await auth.client.auth.signOut();
    await clearRealtime();
    auth.session = null;
    auth.profile = null;
  }

  async function updateTask(id, status) {
    const response = await apiFetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "No se pudo actualizar la tarea.");
    await refreshRealtime();
  }

  async function markNotification(id) {
    const response = await apiFetch(`/api/notifications/${encodeURIComponent(id)}`, { method: "PATCH" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "No se pudo marcar la notificación.");
    }
    await refreshRealtime();
  }

  document.addEventListener("submit", async event => {
    if (event.target.id === "acceptCargoForm" && auth.configured && auth.migrationComplete) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const data = new FormData(event.target);
      try {
        const response = await nativeFetch("/api/public/acceptance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: event.target.dataset.token, acceptedBy: data.get("acceptedBy") })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "No se pudo aceptar el cargo.");
        window.dispatchEvent(new CustomEvent("icc-public-accepted", { detail: payload.message }));
      } catch (error) {
        window.dispatchEvent(new CustomEvent("icc-auth-error", { detail: error.message }));
      }
      return;
    }
    if (!["authLoginForm", "authBootstrapForm", "authPasswordForm"].includes(event.target.id)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.target.dataset.submitting === "true") return;
    event.target.dataset.submitting = "true";
    const submitButton = event.submitter || event.target.querySelector('button[type="submit"],button:not([type])');
    const originalButtonText = submitButton?.textContent || "";
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = event.target.id === "authBootstrapForm" ? "Enviando una sola vez…" : "Procesando…";
    }
    const data = new FormData(event.target);
    try {
      if (event.target.id === "authLoginForm") {
        const { data: result, error } = await auth.client.auth.signInWithPassword({ email: data.get("email"), password: data.get("password") });
        if (error) throw error;
        await handleSession(result.session);
      }
      if (event.target.id === "authBootstrapForm") {
        const response = await nativeFetch("/api/auth/bootstrap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: data.get("token") })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "No se pudo enviar la invitación.");
        alert(payload.message);
        auth.bootstrapUsed = true;
      }
      if (event.target.id === "authPasswordForm") {
        if (data.get("password") !== data.get("confirmation")) throw new Error("Las contraseñas no coinciden.");
        const { error } = await auth.client.auth.updateUser({ password: data.get("password") });
        if (error) throw error;
        auth.passwordSetup = false;
        history.replaceState({}, "", location.pathname);
        await loadProfile();
        subscribeRealtime();
        if (typeof auth.onChange === "function") auth.onChange(appUser());
      }
    } catch (error) {
      window.dispatchEvent(new CustomEvent("icc-auth-error", { detail: error.message || "No se pudo completar el acceso." }));
    } finally {
      event.target.dataset.submitting = "false";
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText;
      }
    }
  }, true);

  document.addEventListener("click", async event => {
    if (event.target.id !== "authForgotButton") return;
    const email = document.querySelector("#authLoginForm [name=email]")?.value;
    if (!email) return window.dispatchEvent(new CustomEvent("icc-auth-error", { detail: "Ingresa primero tu correo." }));
    const redirectTo = `${auth.config.appBaseUrl.replace(/\/+$/, "")}/?auth=recovery`;
    const { error } = await auth.client.auth.resetPasswordForEmail(email, { redirectTo });
    window.dispatchEvent(new CustomEvent("icc-auth-error", { detail: error ? error.message : "Enviamos el enlace de recuperación al correo indicado." }));
  }, true);

  window.ICCAuth = {
    init,
    apiFetch,
    appUser,
    loginMarkup,
    logout,
    updateTask,
    markNotification,
    refreshRealtime,
    get ready() { return auth.ready; },
    get configured() { return auth.configured; },
    get migrationComplete() { return auth.migrationComplete; },
    get passwordSetup() { return auth.passwordSetup; },
    get profile() { return auth.profile; },
    get tasks() { return auth.tasks; },
    get notifications() { return auth.notifications; }
  };
})();
