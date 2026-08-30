import React from "react";
import { CatIcon } from "@/components/cat-icon";
import { EmptyState } from "@/components/ui/primitives";

export default function AppLoading() {
  return (
    <div
      className="paw-page paw-page-narrow"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <EmptyState
        title="正在打开这一页"
        description="PawPlan 正在读取页面所需的数据，不会修改你的计划。"
        action={<CatIcon mood="think" size={48} />}
      />
    </div>
  );
}
