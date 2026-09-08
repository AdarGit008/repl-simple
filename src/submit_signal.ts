import { pythonTypeName } from "./truncate.js";

/**
 * Thrown by `SUBMIT.execute()` to end the run with an answer.
 *
 * `answer` is `unknown`, not `string`, because the type checker cannot see
 * through `SUBMIT(**json.loads(...))` and the value that reaches `execute` is
 * whatever the dict held (#65). The sandbox is where the contract is enforced:
 * it catches this signal and returns `{ status: "ok", output: answer }` for a
 * `str`, and re-raises a Python `TypeError` for anything else (decision 15,
 * D141) — never an uncaught throw, never an `ok` with a non-string output.
 */
export class SubmitSignal extends Error {
  readonly answer: unknown;

  constructor(answer: unknown) {
    super(
      typeof answer === "string"
        ? `SUBMIT: ${answer}`
        : `SUBMIT: <non-str answer (${pythonTypeName(answer)})>`,
    );
    this.name = "SubmitSignal";
    this.answer = answer;
  }
}
