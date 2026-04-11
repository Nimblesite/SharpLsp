export function buildCss(): string {
    return `<style>
@keyframes spin { to { transform: rotate(360deg); } }
.spin { display: inline-block; animation: spin 1s linear infinite; transform-origin: center; }
.spinner { display: inline-flex; align-items: center; gap: 6px; color: #9FCAFF; }
.spinner-label { font-size: 12px; color: #C0C7D3; }

.material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; vertical-align: middle; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #E5E2E1; background: #131313; height: 100vh; overflow: hidden; display: flex; }

/* Main */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

/* Header */
.header { height: 56px; background: #131313; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; z-index: 40; gap: 16px; }
.header-left { display: flex; align-items: center; gap: 24px; min-width: 0; flex: 1; }
.header-right { display: flex; align-items: center; gap: 12px; }
.logo { font-size: 18px; font-weight: 700; color: #9FCAFF; letter-spacing: -0.02em; flex-shrink: 0; }
.nav-tabs { display: flex; height: 56px; flex-shrink: 0; }
.nav-tab { display: flex; align-items: center; padding: 0 16px; color: #C0C7D3; text-decoration: none; font-weight: 500; font-size: 13px; border-bottom: 2px solid transparent; height: 100%; cursor: pointer; transition: all 0.15s; }
.nav-tab:hover { color: #FFFFFF; background: #202020; }
.nav-tab.active { color: #9FCAFF; border-bottom-color: #9FCAFF; font-weight: 600; }

/* Target dropdown */
.target-dropdown { position: relative; min-width: 180px; max-width: 360px; }
.target-dropdown select { width: 100%; height: 32px; background: #0E0E0E; border: 1px solid rgba(138,145,157,0.25); border-radius: 6px; padding: 0 30px 0 32px; color: #E5E2E1; font-size: 12px; font-family: 'Inter', sans-serif; appearance: none; cursor: pointer; text-overflow: ellipsis; }
.target-dropdown select:hover { border-color: #9FCAFF; }
.target-dropdown select:disabled { opacity: 0.6; cursor: wait; }
.target-dropdown .target-icon { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); font-size: 16px; color: #9FCAFF; pointer-events: none; }
.target-dropdown .target-chevron { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); font-size: 16px; color: #C0C7D3; pointer-events: none; }
.target-dropdown .target-spinner { position: absolute; right: 24px; top: 50%; transform: translateY(-50%); font-size: 14px; color: #9FCAFF; }

/* Search box */
.search-box { position: relative; }
.search-box input { width: 240px; height: 30px; background: #0E0E0E; border: 1px solid rgba(138,145,157,0.2); border-radius: 6px; padding: 0 32px 0 36px; color: #E5E2E1; font-size: 13px; font-family: 'Inter', sans-serif; outline: none; transition: all 0.15s; }
.search-box input:focus { border-color: #9FCAFF; box-shadow: 0 0 0 1px rgba(159,202,255,0.1); }
.search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 16px; color: #8A919D; }
.search-spinner { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 16px; color: #9FCAFF; }
.icon-btn { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #C0C7D3; cursor: pointer; border-radius: 4px; transition: all 0.15s; }
.icon-btn:hover { background: #202020; color: #E5E2E1; }
.icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.icon-btn .material-symbols-outlined { font-size: 20px; }

/* Toast */
.toast { position: fixed; bottom: 16px; right: 16px; max-width: 420px; min-width: 260px; background: #1B1B1C; border: 1px solid rgba(159,202,255,0.3); border-radius: 8px; padding: 12px 16px; color: #E5E2E1; display: flex; align-items: center; gap: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); z-index: 100; }
.toast.error { border-color: rgba(255,180,171,0.4); color: #FFB4AB; }
.toast.success { border-color: rgba(159,202,255,0.4); }
.toast-icon { font-size: 18px !important; }
.toast-text { font-size: 12px; line-height: 1.4; }

/* Content */
.content { flex: 1; display: flex; overflow: hidden; }
.package-list { flex: 1; overflow-y: auto; padding: 16px; }
.list-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 16px 16px; }
.list-title { font-size: 18px; font-weight: 700; color: #E5E2E1; letter-spacing: -0.02em; }
.inline-loading-row { display: flex; align-items: center; gap: 8px; padding: 12px 16px; color: #C0C7D3; font-size: 12px; }

/* Skeleton */
.skeleton { padding: 16px; display: flex; gap: 16px; border-radius: 6px; margin-bottom: 8px; background: #181818; }
.skeleton-icon { width: 40px; height: 40px; border-radius: 4px; background: #242424; flex-shrink: 0; }
.skeleton-lines { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.skeleton-line { height: 10px; background: #242424; border-radius: 4px; }
.skeleton-line.short { width: 40%; }
.skeleton-line.med { width: 70%; }
.skeleton-line.long { width: 100%; }
@keyframes pulse { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }
.skeleton { animation: pulse 1.4s ease-in-out infinite; }

/* Package items */
.package-item { display: flex; gap: 16px; padding: 16px; border-radius: 6px; border-left: 2px solid transparent; cursor: pointer; transition: all 0.15s; margin-bottom: 8px; }
.package-item:hover { background: #1B1B1C; }
.package-item.selected { background: #1B1B1C; border-left-color: #9FCAFF; }
.package-item.pending { opacity: 0.8; }
.package-icon-box { width: 40px; height: 40px; border-radius: 4px; background: #202020; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.package-icon-box.selected { background: #007ACC; }
.package-icon-box .material-symbols-outlined { font-size: 20px; color: #9FCAFF; }
.package-icon-box.selected .material-symbols-outlined { color: #FFFFFF; }
.icon-selected { color: #FFFFFF !important; }
.package-content { flex: 1; min-width: 0; }
.package-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; }
.package-name { font-size: 15px; font-weight: 600; color: #E5E2E1; }
.package-version { font-size: 11px; color: #C0C7D3; background: #2A2A2A; padding: 2px 8px; border-radius: 999px; }
.package-version.installed { background: rgba(159,202,255,0.18); color: #9FCAFF; }
.package-version.pending { background: rgba(159,202,255,0.25); color: #9FCAFF; }
.package-description { font-size: 13px; color: #C0C7D3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 12px; }
.package-meta { display: flex; gap: 16px; }
.meta-item { display: flex; align-items: center; gap: 4px; font-size: 0.65rem; color: rgba(192,199,211,0.7); }
.meta-icon { font-size: 1rem !important; }

/* Details panel */
.details-panel { width: 384px; background: #1B1B1C; border-left: 1px solid rgba(64,71,81,0.1); overflow-y: auto; padding: 24px; flex-shrink: 0; }
.details-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #C0C7D3; text-align: center; gap: 16px; }
.empty-icon { font-size: 48px; opacity: 0.5; }
.empty-title { font-size: 16px; font-weight: 600; color: #E5E2E1; margin-bottom: 8px; }
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px; color: #C0C7D3; text-align: center; }
.details-header { display: flex; gap: 12px; margin-bottom: 16px; }
.details-icon-box { width: 48px; height: 48px; border-radius: 8px; background: #007ACC; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.details-icon-glyph { font-size: 24px; color: #FFFFFF; }
.details-title h2 { font-size: 18px; font-weight: 700; color: #E5E2E1; line-height: 1.2; }
.details-title p { font-size: 12px; color: #C0C7D3; }
.details-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 24px; }
.btn { height: 36px; border-radius: 6px; border: none; font-size: 13px; font-weight: 600; font-family: 'Inter', sans-serif; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.15s; }
.btn:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-icon { font-size: 16px !important; }
.btn-primary { background: #007ACC; color: #FFFFFF; }
.btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
.btn-danger { background: rgba(255,180,171,0.12); color: #FFB4AB; }
.btn-danger:hover:not(:disabled) { background: rgba(255,180,171,0.2); }
.version-select { position: relative; }
.version-select select { width: 100%; height: 36px; background: #2A2A2A; border: 1px solid rgba(64,71,81,0.2); border-radius: 6px; padding: 0 32px 0 12px; color: #E5E2E1; font-size: 12px; font-family: 'Inter', sans-serif; appearance: none; cursor: pointer; }
.version-select select:disabled { opacity: 0.6; cursor: wait; }
.version-chevron { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 16px; pointer-events: none; color: #C0C7D3; }

/* Sections */
.section { margin-bottom: 24px; }
.section-title { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #C0C7D3; margin-bottom: 12px; }
.section-content { font-size: 12px; line-height: 1.6; color: #C0C7D3; }
.info-grid { display: flex; flex-direction: column; gap: 4px; }
.info-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(64,71,81,0.05); }
.info-label { font-size: 0.7rem; color: #C0C7D3; }
.info-value { font-size: 0.7rem; color: #E5E2E1; }
.info-link { font-size: 0.7rem; color: #9FCAFF; text-decoration: none; display: flex; align-items: center; gap: 4px; }
.info-link:hover { text-decoration: underline; }
.tags { display: flex; flex-wrap: wrap; gap: 8px; }
.tag { padding: 4px 8px; background: #353535; border: 1px solid rgba(64,71,81,0.1); border-radius: 999px; font-size: 0.6rem; color: #C0C7D3; text-transform: uppercase; letter-spacing: 0.02em; }

/* Scrollbar */
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: #131313; }
::-webkit-scrollbar-thumb { background: #353535; }
::-webkit-scrollbar-thumb:hover { background: #404751; }
</style>`;
}
