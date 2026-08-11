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

  async function openEvidenceVerification() {
    modal("Verificación de evidencias", '<p class="empty">Consultando comprobaciones…</p>');
    const data = await logisticsFetch("/api/admin/evidence-verification-runs");
    const runs = data.runs || [], failures = data.failures || [], latest = runs[0];
    modal("Verificación de evidencias", `<div class="grid metrics">
      <div class="card"><div class="metric-label">Último resultado</div><div class="metric-value">${latest ? statusLabel(latest.status) : "—"}</div></div>
      <div class="card"><div class="metric-label">Verificados</div><div class="metric-value">${latest?.verified_count || 0}</div></div>
      <div class="card"><div class="metric-label">Faltantes</div><div class="metric-value">${latest?.missing_count || 0}</div></div>
      <div class="card"><div class="metric-label">Alterados / errores</div><div class="metric-value">${Number(latest?.corrupt_count || 0) + Number(latest?.error_count || 0)}</div></div>
    </div><div class="access-box"><strong>Comprobación real</strong><div>La aplicación recupera cada archivo seleccionado, recalcula tamaño y SHA-256 y compara el resultado con su registro original.</div></div>
    <div class="form-actions"><button class="button" data-run-evidence-verification="25">Verificar 25 archivos</button><button class="button secondary" data-run-evidence-verification="100">Verificar hasta 100</button></div>
    <h3 class="section-title">Comprobaciones recientes</h3>${runs.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Resultado</th><th>Revisados</th><th>Fallas</th><th>Responsable</th></tr></thead><tbody>${runs.map(run => `<tr><td>${new Date(run.started_at).toLocaleString("es-CL")}</td><td>${tag(run.status)}</td><td>${Number(run.verified_count || 0) + Number(run.missing_count || 0) + Number(run.corrupt_count || 0) + Number(run.error_count || 0)}</td><td>${Number(run.missing_count || 0) + Number(run.corrupt_count || 0) + Number(run.error_count || 0)}</td><td>${htmlSafe(run.initiated_by_name || "Administrador")}</td></tr>`).join("")}</tbody></table></div>` : '<p class="empty">Aún no se han comprobado evidencias.</p>'}
    ${failures.length ? `<h3 class="section-title">Hallazgos</h3><div class="table-wrap"><table><thead><tr><th>Archivo</th><th>Estado</th><th>Detalle</th><th>Fecha</th></tr></thead><tbody>${failures.map(item => `<tr><td><strong>${htmlSafe(item.filename)}</strong><br><small>${htmlSafe(item.category || "Documento")}</small></td><td>${tag(item.status)}</td><td>${htmlSafe(item.detail || "Requiere revisión")}</td><td>${new Date(item.checked_at).toLocaleString("es-CL")}</td></tr>`).join("")}</tbody></table></div>` : ""}`);
  }

  async function runEvidenceCheck(limit) {
    toast("Verificando disponibilidad e integridad de evidencias…");
    const result = await logisticsFetch("/api/admin/evidence-verification-runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: Number(limit) || 25 })
    });
    toast(result.run?.status === "PASS"
      ? "Evidencias comprobadas sin diferencias."
      : "Se detectaron evidencias que requieren revisión.");
    await openEvidenceVerification();
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
    const documentCard = document.querySelector("[data-document-governance-card]");
    if (documentCard && !documentCard.querySelector("[data-evidence-verification]")) {
      const documentActions = documentCard.querySelector(".heading-row");
      if (documentActions) {
        const evidenceButton = document.createElement("button");
        evidenceButton.className = "button secondary";
        evidenceButton.dataset.evidenceVerification = "";
        evidenceButton.textContent = "Verificar evidencias";
        documentActions.appendChild(evidenceButton);
      }
    }
  }

  new MutationObserver(installButton).observe(document.getElementById("view"), {
    childList: true, subtree: true
  });
  installButton();

  document.addEventListener("click", async event => {
    const target = event.target.closest?.("[data-file-access-monitor],[data-file-alert-review],[data-file-alert-dismiss],[data-file-alert-confirm],[data-evidence-verification],[data-run-evidence-verification]");
    if (!target) return;
    try {
      if (target.dataset.fileAccessMonitor !== undefined) await openAccessMonitor();
      if (target.dataset.fileAlertReview) await updateAlert(target.dataset.fileAlertReview, "REVIEWING");
      if (target.dataset.fileAlertDismiss) await updateAlert(target.dataset.fileAlertDismiss, "DISMISSED");
      if (target.dataset.fileAlertConfirm) await updateAlert(target.dataset.fileAlertConfirm, "CONFIRMED");
      if (target.dataset.evidenceVerification !== undefined) await openEvidenceVerification();
      if (target.dataset.runEvidenceVerification) await runEvidenceCheck(target.dataset.runEvidenceVerification);
    } catch (error) {
      toast(error.message || "No se pudo revisar la alerta de acceso.");
    }
  }, true);
})();
