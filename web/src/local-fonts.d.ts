// Local Font Access API (Chrome/Edge), not in lib.dom.
// https://wicg.github.io/local-font-access/

interface FontData {
  readonly family: string;
  readonly fullName: string;
  readonly postscriptName: string;
  readonly style: string;
  blob(): Promise<Blob>;
}

interface QueryLocalFontsOptions {
  postscriptNames?: string[];
}

interface Window {
  // Only some browsers have it: check `'queryLocalFonts' in window` first.
  queryLocalFonts(options?: QueryLocalFontsOptions): Promise<FontData[]>;
}

interface Permissions {
  query(permissionDesc: { name: 'local-fonts' }): Promise<PermissionStatus>;
}
