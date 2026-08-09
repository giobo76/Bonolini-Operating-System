import type { TaskExecutionContext, TaskResult, TaskRequest } from "./tasks";

export type PipelineStep = (
  context: TaskExecutionContext,
) => Promise<TaskExecutionContext>;

export class TaskPipeline {
  constructor(private readonly steps: PipelineStep[] = []) {}

  use(step: PipelineStep): void {
    this.steps.push(step);
  }

  async execute(task: TaskRequest, context: TaskExecutionContext): Promise<TaskResult> {
    let nextContext = { ...context, task };

    for (const step of this.steps) {
      nextContext = await step(nextContext);
    }

    if (!nextContext.result) {
      throw new Error("Task pipeline did not produce a result.");
    }

    return nextContext.result;
  }
}
