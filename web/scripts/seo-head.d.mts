export declare const SITE_ORIGIN: string;
export declare const OG_IMAGE: { path: string; width: number; height: number };
export declare function enPath(path: string): string;
export declare function esc(x: string): string;
export declare function jsonLd(lang: "fr" | "en"): string;
export declare function seoHead(o: { path: string | undefined; lang?: "fr" | "en"; title?: string; description?: string }): string;
export declare function sitemapXml(paths: readonly string[]): string;
