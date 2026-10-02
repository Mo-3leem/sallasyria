// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pagination } from "./Pagination.js";

afterEach(cleanup);

function buttons() {
  return screen.getAllByRole("button") as HTMLButtonElement[];
}

describe("Pagination", () => {
  it("renders nothing when there is a single page or less", () => {
    const { container, rerender } = render(
      <Pagination page={1} totalPages={1} onPage={() => {}} />
    );
    expect(container.firstChild).toBeNull();
    rerender(<Pagination page={1} totalPages={0} onPage={() => {}} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("shows first, last, and current±1 with ellipsis gaps", () => {
    const onPage = vi.fn();
    render(<Pagination page={5} totalPages={10} onPage={onPage} />);
    // prev + [1, 4, 5, 6, 10] + next = 7 buttons, 2 ellipsis gaps.
    const all = buttons();
    expect(all).toHaveLength(7);
    expect(document.querySelectorAll(".pager-ellipsis")).toHaveLength(2);
    fireEvent.click(all[1]!);
    expect(onPage).toHaveBeenLastCalledWith(1);
    fireEvent.click(all[2]!);
    expect(onPage).toHaveBeenLastCalledWith(4);
    fireEvent.click(all[4]!);
    expect(onPage).toHaveBeenLastCalledWith(6);
    fireEvent.click(all[5]!);
    expect(onPage).toHaveBeenLastCalledWith(10);
  });

  it("collapses the window at the boundaries", () => {
    const onPage = vi.fn();
    const { unmount } = render(<Pagination page={1} totalPages={10} onPage={onPage} />);
    // prev + [1, 2, 10] + next, single ellipsis gap.
    expect(buttons()).toHaveLength(5);
    expect(document.querySelectorAll(".pager-ellipsis")).toHaveLength(1);
    unmount();
    render(<Pagination page={10} totalPages={10} onPage={onPage} />);
    // prev + [1, 9, 10] + next.
    expect(buttons()).toHaveLength(5);
  });

  it("disables previous on the first page and next on the last page", () => {
    const onPage = vi.fn();
    const { unmount } = render(<Pagination page={1} totalPages={4} onPage={onPage} />);
    let all = buttons();
    expect(all[0]?.disabled).toBe(true);
    expect(all[all.length - 1]?.disabled).toBe(false);
    unmount();
    render(<Pagination page={4} totalPages={4} onPage={onPage} />);
    all = buttons();
    expect(all[0]?.disabled).toBe(false);
    expect(all[all.length - 1]?.disabled).toBe(true);
  });

  it("marks only the current page with aria-current", () => {
    render(<Pagination page={5} totalPages={10} onPage={() => {}} />);
    const current = screen.getAllByRole("button", { name: (_name, el) => el.getAttribute("aria-current") === "page" });
    expect(current).toHaveLength(1);
  });

  it("wires clicks to prev, numbered, and next pages", () => {
    const onPage = vi.fn();
    render(<Pagination page={5} totalPages={10} onPage={onPage} />);
    const all = buttons();
    fireEvent.click(all[0]!);
    expect(onPage).toHaveBeenLastCalledWith(4);
    fireEvent.click(all[4]!);
    expect(onPage).toHaveBeenLastCalledWith(6);
    fireEvent.click(all[all.length - 1]!);
    expect(onPage).toHaveBeenLastCalledWith(6);
  });

  it("disables every button when disabled", () => {
    render(<Pagination page={5} totalPages={10} onPage={() => {}} disabled />);
    for (const b of buttons()) {
      expect(b.disabled).toBe(true);
    }
  });
});
