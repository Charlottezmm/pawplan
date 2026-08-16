import { redirect } from "next/navigation";

export default function MonthPage({ searchParams }: { searchParams: { month?: string } }) {
  const month = searchParams.month ? `&month=${encodeURIComponent(searchParams.month)}` : "";
  redirect(`/plan?view=month${month}`);
}
