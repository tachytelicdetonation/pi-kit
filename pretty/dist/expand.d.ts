/** Render context from pi tool UI (Ctrl+O toggles `expanded` per tool block). */
export type ToolRenderCtx = {
    expanded?: boolean;
};
/** Lines to show in tool result body when collapsed vs expanded. */
export declare function previewLineCount(ctx: ToolRenderCtx, totalLines: number): number;
//# sourceMappingURL=expand.d.ts.map