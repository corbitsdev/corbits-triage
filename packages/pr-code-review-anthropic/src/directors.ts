import { gather } from "./gather-director.js";
import { reader } from "./reader-director.js";
import { structured } from "./structured-director.js";

export const readerDirectorFactory = reader.factory;
export const gatherDirectorFactory = gather.factory;
export const structuredDirectorFactory = structured.factory;
