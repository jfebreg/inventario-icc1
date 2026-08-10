(function () {
  const statusLabel = value => ({
    OPEN: "Pendiente", REVIEWING: "En revisión",
    DISMISSED: "Descartada", CONFIRMED: "Confirmada"
  }[value] || value);

  function alertRows(alerts) {
    if (!alerts.length) return '<p class="empty">No existen alertas de descarga.</p>';
    return `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Usuario</th><th>Actividad</th><th>Riesgo</th><th>Estado</th><th>Acción</th></tr></thead><tbody>${alerts.map(alert => `<tr>
      <td>${new Date(alert.created_at).toLocaleString("es-CL")}</td>
      <td><strong>${htmlSafe(alert.actor_name || alert.actor_profile_id)}</strong></td>
      <td>${alert.access_count} descarga(s)<br><small>${alert.sensitive_access_count} sensibles · ${alert.distinct_file_count} archivo(s)</small></td>
      <td>${tag(alert.risk_level)}</td><td>${tag(statusLabel(alert.status))}</td>
      <td>${["DISMISSED", "CONFIRMED"].includes(alert.status) ? `<small>${htmlSafe(alert.review_notes || "Revisión cerrada")}</small>` : `<div class="actions"><button class="link-button" data-file-alert-review="${alert.id}">Revisar</button><button class="link-button" data-file-alert-dismiss="${alert.id}">Descartar</button><button class="link-button" data-file-alert-confirm="${alert.id}">Confirmar</button></div>`}</td>
    </tr>`).join("")}</tbody></table></div>`;
  }

  async function openAccessMonitor() {
    modal("Alertas de acceso documental", '<p class="empty">Consultando actividad…</p>');
    const data = await logisticsFetch("/api/admin/privacy-governance");
    const alerts = data.accessAlerts || [];
    const open = alerts.filter(alert => !["DISMISSED", "CONFIRMED"].includes(alert.status));
    modal("Alertas de acceso documental", `<div class="grid metrics">
      <div class="card"><div class="metric-label">Alertas abiertas</div><div class="metric-value">${open.length}</div></div>
      <div class="card"><div class="metric-label">Críticas abiertas</div><div class="metric-value">${open.filter(alert => alert.risk_level === "CRITICAL").length}</div></div>
      <div class="card"><div class="metric-label">Revisadas</div><div class="metric-value">${alerts.length - open.length}</div></div>
    </div><div class="access-box"><strong>Detección automática</strong><div>Se alerta por volumen inusual durante 15 minutos. El control no bloquea una descarga autorizada; exige revisión y conserva una trazabilidad inalterable.</div></div>${alertRows(alerts)}`);
  }

  async function updateAlert(id, status) {
    const closing = ["DISMISSED", "CONFIRMED"].includes(status);
    const notes = closing ? prompt(status === "CONFIRMED"
      ? "Describe por qué el acceso se considera no autorizado:"
      : "Explica por qué la actividad es legítima:") : "Revisión administrativa iniciada.";
    if (notes == null) return;
    await logisticsFetch(`/api/admin/file-access-alerts/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, notes })
    });
    toast(status === "CONFIRMED"
      ? "Acceso confirmado. Se creó una tarea crítica de respuesta."
      : status === "DISMISSED" ? "Alerta descartada con fundamento." : "Revisión iniciada.");
    await openAccessMonitor();
  }

  function installButton() {
    const card = document.querySelector("[data-privacy-governance-card]");
    if (!card || card.querySelector("[data-file-access-monitor]")) return;
    const actions = card.querySelector(".heading-row");
    if (!actions) return;
    const button = document.createElement("button");
    button.className = "button secondary";
    button.dataset.fileAccessMonitor = "";
    button.textContent = "Alertas de acceso";
    actions.appendChild(button);
  }

  new MutationObserver(installButton).observe(document.getElementById("view"), {
    childList: true, subtree: true
  });
  installButton();

  document.addEventListener("click", async event => {
    const target = event.target.closest?.("[data-file-access-monitor],[data-file-alert-review],[data-file-alert-dismiss],[data-file-alert-confirm]");
    if (!target) return;
    try {
      if (target.dataset.fileAccessMonitor !== undefined) await openAccessMonitor();
      if (target.dataset.fileAlertReview) await updateAlert(target.dataset.fileAlertReview, "REVIEWING");
      if (target.dataset.fileAlertDismiss) await updateAlert(target.dataset.fileAlertDismiss, "DISMISSED");
      if (target.dataset.fileAlertConfirm) await updateAlert(target.dataset.fileAlertConfirm, "CONFIRMED");
    } catch (error) {
      toast(error.message || "No se pudo revisar la alerta de acceso.");
    }
  }, true);
})();
