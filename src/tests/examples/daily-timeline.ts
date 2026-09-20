// Read-only reproducible example: consumes an explicit source snapshot; never connects to a database.
// Usage: npx tsx src/tests/examples/daily-timeline.ts /path/to/private-snapshot.json
import { readFileSync } from "node:fs";
import { buildDailyTimeline } from "../../lib/planning/daily-timeline";
const input = process.argv[2];
if (!input) throw new Error("Supply an explicit source/request JSON snapshot");
const { source, request } = JSON.parse(readFileSync(input, "utf8"));
console.log(JSON.stringify(buildDailyTimeline(source, request), null, 2));
