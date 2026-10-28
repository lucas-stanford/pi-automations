import type { FileContent, FileLanguage, FileListing } from "../plugins/types.js";
import type { Located } from "../types.js";
export declare function sameName(a: string, b: string): boolean;
export declare function normalizeBrowserPath(input: string | null, opts?: {
    allowEmpty: boolean;
    creating?: boolean;
}): string;
export declare function resolveInside(root: string, rel: string, opts?: {
    mustExist?: boolean;
    creating?: boolean;
}): string;
export declare function languageFor(rel: string): FileLanguage;
export declare function listFiles(located: Located, rel: string): FileListing;
export declare function readTextFile(located: Located, rel: string): FileContent;
export declare function atomicWriteText(file: string, text: string, bom?: boolean): void;
export declare function writeTextFile(located: Located, rel: string, body: {
    text: string;
    base: string | null;
    bom?: boolean;
}): FileContent;
export declare function writableDir(dir: string): boolean;
