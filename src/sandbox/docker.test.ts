import { describe, expect, it } from "vitest";
import { countEnvelopes } from "./docker.js";
import { RESULT_END, RESULT_START } from "../attack/markers.js";

const envelope = (body: string) => `\n${RESULT_START}\n${body}\n${RESULT_END}\n`;

/**
 * The agent shares stdout with the runner and runs in the same pid namespace.
 * If it can get a second envelope onto the stream, it can dictate the trial's
 * evidence. One envelope is the runner's; more than one is ambiguous, and
 * ambiguous evidence is not evidence.
 */
describe("countEnvelopes", () => {
  it("counts the one the runner writes", () => {
    expect(countEnvelopes(`some logs${envelope('{"ruleId":"a","events":[]}')}`)).toBe(1);
  });

  it("counts a forged envelope written before the real one", () => {
    expect(countEnvelopes(`${envelope('{"ruleId":"a","events":[]}')}logs${envelope('{"ruleId":"a","events":[1]}')}`)).toBe(2);
  });

  it("counts a forged envelope written after the real one", () => {
    expect(countEnvelopes(`${envelope('{"ruleId":"a","events":[1]}')}${envelope('{"ruleId":"a","events":[]}')}`)).toBe(2);
  });

  it("is zero when the run produced nothing", () => {
    expect(countEnvelopes("container exited 1\n")).toBe(0);
  });

  it("does not count a start marker with no end", () => {
    expect(countEnvelopes(`\n${RESULT_START}\n{"ruleId":"a"}\n`)).toBe(0);
  });

  it("does not count the markers appearing inside a tool result", () => {
    // An agent echoing the marker text without a closing marker must not shift the count.
    expect(countEnvelopes(`the agent printed ${RESULT_START} in a log line${envelope('{"ruleId":"a","events":[]}')}`)).toBe(1);
  });
});
