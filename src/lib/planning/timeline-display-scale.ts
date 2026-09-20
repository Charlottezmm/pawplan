// Expand short occupied spans so consecutive tasks have distinct, readable hit areas.
// Clock labels and all event boundaries share this mapping; gaps retain normal scale.
export function timelineDisplayScale(start: number, end: number, intervals: {startMinute:number;endMinute:number}[]) {
  const points = [...new Set([start, end, ...intervals.flatMap(i=>[i.startMinute,i.endMinute])])].filter(n=>n>=start&&n<=end).sort((a,b)=>a-b);
  const positions=[0];
  for(let i=1;i<points.length;i++) {
    const a=points[i-1], b=points[i];
    const occupied=intervals.some(t=>t.startMinute<b&&t.endMinute>a);
    positions.push(positions[i-1]+(occupied?Math.max(48,b-a):b-a));
  }
  return (minute:number) => {
    const m=Math.max(start,Math.min(end,minute));
    const i=points.findIndex((p,j)=>j>0&&p>=m);
    if(i<1)return 0;
    return positions[i-1]+(m-points[i-1])/(points[i]-points[i-1])*(positions[i]-positions[i-1]);
  };
}
