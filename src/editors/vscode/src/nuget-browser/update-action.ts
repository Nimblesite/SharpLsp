// Update action view for [NUGET-REQUESTS-UPDATE-CONFIRM].
/** Installed packages get a bounded update action independent of explicit versions. */
export function buildUpdateButton(escapedId: string, pending: boolean, spinner: string): string {
  const label = pending
    ? `${spinner} Updating…`
    : '<span class="material-symbols-outlined btn-icon">upgrade</span> Update';
  return `<button class="btn btn-primary update-package" ${pending ? 'disabled' : ''} onclick="updatePackage('${escapedId}')">${label}</button>`;
}
