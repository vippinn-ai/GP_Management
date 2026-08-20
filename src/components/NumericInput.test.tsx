import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NumericInput } from "./NumericInput";

function NumericInputHarness(props: {
  initialValue: number;
  defaultValue?: number;
  min?: number;
  mode?: "integer" | "decimal";
  onValueChange: (value: number) => void;
}) {
  const [value, setValue] = useState(props.initialValue);

  return (
    <label>
      Qty
      <NumericInput
        value={value}
        min={props.min ?? 1}
        mode={props.mode}
        defaultValue={props.defaultValue}
        onValueChange={(nextValue) => {
          props.onValueChange(nextValue);
          setValue(nextValue);
        }}
      />
    </label>
  );
}

describe("NumericInput", () => {
  it("does not emit the same committed value again on blur", () => {
    const onValueChange = vi.fn();
    render(<NumericInputHarness initialValue={1} defaultValue={1} onValueChange={onValueChange} />);

    const input = screen.getByLabelText("Qty");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.blur(input);

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(2);
  });

  it("does not emit when an unchanged value is focused and blurred", () => {
    const onValueChange = vi.fn();
    render(<NumericInputHarness initialValue={2} defaultValue={1} onValueChange={onValueChange} />);

    const input = screen.getByLabelText("Qty");
    fireEvent.focus(input);
    fireEvent.blur(input);

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("still commits the configured fallback when a different value is cleared", () => {
    const onValueChange = vi.fn();
    render(<NumericInputHarness initialValue={2} defaultValue={1} onValueChange={onValueChange} />);

    const input = screen.getByLabelText("Qty");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(1);
  });

  it("still corrects a controlled value below the minimum on blur", () => {
    const onValueChange = vi.fn();
    render(<NumericInputHarness initialValue={0} min={1} onValueChange={onValueChange} />);

    const input = screen.getByLabelText("Qty");
    fireEvent.focus(input);
    fireEvent.blur(input);

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(1);
  });

  it("still normalizes an unrounded decimal controlled value on blur", () => {
    const onValueChange = vi.fn();
    render(
      <NumericInputHarness initialValue={1.239} min={0} mode="decimal" onValueChange={onValueChange} />
    );

    const input = screen.getByLabelText("Qty");
    fireEvent.focus(input);
    fireEvent.blur(input);

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(1.24);
  });

  it("still truncates an unnormalized integer controlled value on blur", () => {
    const onValueChange = vi.fn();
    render(<NumericInputHarness initialValue={2.7} min={1} onValueChange={onValueChange} />);

    const input = screen.getByLabelText("Qty");
    fireEvent.focus(input);
    fireEvent.blur(input);

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(2);
  });
});
