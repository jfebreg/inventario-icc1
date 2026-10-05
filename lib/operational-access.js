export function enforceOperationalOrganization(body, organizationId) {
  const requested = body.organizationId;
  if (requested != null && requested !== ""
      && String(requested).toLowerCase() !== String(organizationId).toLowerCase()) {
    const error = new Error("La operación no pertenece a la organización de esta aplicación.");
    error.status = 403;
    error.code = "ORGANIZATION_SCOPE_DENIED";
    throw error;
  }
  body.organizationId = organizationId;
  return body;
}
