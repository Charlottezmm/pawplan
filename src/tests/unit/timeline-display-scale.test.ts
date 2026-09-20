import {expect,it} from "vitest";
import {timelineDisplayScale} from "@/lib/planning/timeline-display-scale";
it("gives adjacent short tasks separate readable space without changing clock boundaries",()=>{
const p=timelineDisplayScale(480,1320,[{startMinute:1255,endMinute:1275},{startMinute:1275,endMinute:1290}]);
expect(p(1275)-p(1255)).toBe(48);
expect(p(1290)-p(1275)).toBe(48);
expect(p(600)-p(540)).toBe(60);
expect(p(1320)-p(1290)).toBe(30);
});
