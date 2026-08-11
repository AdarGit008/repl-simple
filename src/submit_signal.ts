/**
 * Thrown by SUBMIT.execute() after recording the call trace.
 * Caught by the sandbox loop to terminate execution cleanly
 * and return { status: "ok", output: answer }.
 */
export class SubmitSignal extends Error {
  readonly answer: string;

  constructor(answer: string) {
    super(`SUBMIT: ${answer}`);
    this.name = "SubmitSignal";
    this.answer = answer;
  }
}
