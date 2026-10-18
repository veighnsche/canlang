/** Private process entry for exactly one portable build; the parent owns scratch. */
import { readFileSync, writeFileSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import { buildDeployBundleWithAssets, type ProducerBundleRecords } from "./bundle.js";
import type { OwnedBundleJob, OwnedBundleReply } from "./owned-bundle.js";

const [jobPath, resultPath] = process.argv.slice(2);
if (jobPath === undefined || resultPath === undefined) throw new Error("owned bundle job paths are missing");
const job = deserialize(readFileSync(jobPath)) as OwnedBundleJob;
let reply: OwnedBundleReply;
try {
  let producers: ProducerBundleRecords | undefined;
  const bundle = buildDeployBundleWithAssets(job.artifact, job.options, (records) => {
    producers = records;
  });
  reply = { ok: true, bundle, ...(producers === undefined ? {} : { producers }) };
} catch (error) {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  reply = { ok: false, error, ...(code === undefined ? {} : { code }) };
}
writeFileSync(resultPath, serialize(reply));
