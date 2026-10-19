import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureConfig } from "../playwright.fixture-config.js";

export default fixtureConfig(dirname(fileURLToPath(import.meta.url)));
