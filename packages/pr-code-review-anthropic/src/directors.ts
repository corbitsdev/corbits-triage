import { consolidate } from "./consolidate-director.js";
import { reader } from "./reader-director.js";
import { structured } from "./structured-director.js";

export const readerDirectorFactory = reader.factory;
export const consolidateDirectorFactory = consolidate.factory;
export const structuredDirectorFactory = structured.factory;
