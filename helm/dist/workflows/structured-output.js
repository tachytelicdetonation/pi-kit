import { defineTool } from "@earendil-works/pi-coding-agent";
const DEFAULT_STRUCTURED_OUTPUT_NAME = "structured_output";
/**
 * Produce a terminating tool a subagent invokes to hand back its final,
 * machine-readable answer.
 *
 * The host validates the incoming arguments against `schema` before `execute`
 * runs, so the captured payload is already typed as `Static<TSchemaDef>`.
 * Returning `terminate: true` lets the subagent stop on this call rather than
 * spending another assistant turn to close out the task.
 */
export function createStructuredOutputTool(options) {
    const { schema, capture } = options;
    const toolName = options.name ?? DEFAULT_STRUCTURED_OUTPUT_NAME;
    return defineTool({
        name: toolName,
        label: "Structured Output",
        description: "Deliver this subagent's final result as a machine-readable value.",
        promptSnippet: "Emit the final machine-readable result",
        promptGuidelines: [
            `Report the task's conclusion through ${toolName}; call it exactly one time, and only once the work is complete.`,
            `After ${toolName} has been called, add nothing further — do not follow it with a written answer.`,
        ],
        parameters: schema,
        async execute(_toolCallId, params) {
            capture.called = true;
            capture.value = params;
            return {
                content: [{ type: "text", text: "Structured output received." }],
                details: params,
                terminate: true,
            };
        },
    });
}
