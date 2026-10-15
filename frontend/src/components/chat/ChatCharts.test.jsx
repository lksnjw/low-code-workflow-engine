/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InlineVisualisation } from "./ChatMessageVisualisation";
afterEach(cleanup);
const data = [{ label: "Procurement and supplier management", value: 12 }, { label: "Finance", value: 8 }, { label: "Operations", value: 5 }];
const vis = (type, rows = data) => ({ type, title: "UI fixture only", data: rows });

test.each(["bar", "line", "pie", "table"])("%s renders its actual chart and a complete accessible data table", type => {
  const { container } = render(<InlineVisualisation vis={vis(type)} />);
  expect(screen.getByRole("figure", { name: `UI fixture only — ${type} chart` })).toBeTruthy();
  if (type !== "table") fireEvent.click(screen.getByText("View chart data · 3 rows"));
  const table = screen.getByRole("table", { name: "UI fixture only — data" });
  expect(table.textContent).toContain("Procurement and supplier management");
  expect(table.textContent).toContain("12"); expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
  expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
});

test("bar labels remain complete and zero has no fabricated minimum bar length", () => {
  const { container } = render(<InlineVisualisation vis={vis("bar", [{ label: "SCP-PO-2026-00001-full-label", value: 0 }])} />);
  expect(screen.getAllByText("SCP-PO-2026-00001-full-label")[0].className).not.toContain("truncate");
  expect(container.querySelector("span.bg-primary").style.width).toBe("0%");
});

test("a signed bar uses the zero baseline without presenting negative values as positive", () => {
  const { container } = render(<InlineVisualisation vis={vis("bar", [{ label: "Credit", value: -20 }, { label: "Debit", value: 40 }])} />);
  const bars = container.querySelectorAll("span.bg-primary");
  expect(parseFloat(bars[0].style.left)).toBe(0);
  expect(parseFloat(bars[0].style.width)).toBeCloseTo(100 / 3);
  expect(parseFloat(bars[1].style.left)).toBeCloseTo(100 / 3);
  expect(parseFloat(bars[1].style.width)).toBeCloseTo(200 / 3);
});

test("bar truncation is explicit and the data table keeps all rows", () => {
  const rows = Array.from({ length: 13 }, (_, i) => ({ label: `Department ${i + 1}`, value: i }));
  const { container } = render(<InlineVisualisation vis={vis("bar", rows)} />);
  expect(container.querySelectorAll("span.bg-primary")).toHaveLength(10);
  expect(screen.getByText(/Showing the first 10 of 13 bars/)).toBeTruthy();
  fireEvent.click(screen.getByText("View chart data · 13 rows"));
  expect(screen.getByRole("table").querySelectorAll("tbody tr")).toHaveLength(13);
});

test("line plot includes labelled points, numeric axis ticks and a single-point limitation", () => {
  const { container } = render(<InlineVisualisation vis={vis("line", [{ label: "Monday", value: 4 }])} />);
  expect(screen.getByRole("img", { name: "UI fixture only — line plot" })).toBeTruthy();
  expect(container.querySelectorAll("svg circle")).toHaveLength(1);
  expect(container.querySelector("svg circle title").textContent).toBe("Monday: 4");
  expect(container.querySelectorAll("svg text")).toHaveLength(3);
  expect(screen.getByText(/One data point — no trend/)).toBeTruthy();
});

test.each(["bar", "line"])("%s handles zero, signed and very large finite values without invalid geometry", type => {
  const { container } = render(<InlineVisualisation vis={vis(type, [{ label: "Low", value: -1e308 }, { label: "Zero", value: 0 }, { label: "High", value: 1e308 }])} />);
  expect([...container.querySelectorAll("[style],path,circle")].map(el => el.getAttribute("style") + el.getAttribute("d") + el.getAttribute("cy")).join("")).not.toMatch(/NaN|Infinity/);
});

test("pie displays every category, totals and percentages rather than hiding the ninth legend item", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ label: `Category ${i + 1}`, value: 1 }));
  const { container } = render(<InlineVisualisation vis={vis("pie", rows)} />);
  expect(container.querySelectorAll("li")).toHaveLength(9);
  expect(screen.getAllByText("Category 9").length).toBeGreaterThan(0);
  expect(screen.getByRole("img", { name: "UI fixture only — pie plot, total 9" })).toBeTruthy();
  expect(screen.getAllByText("11.1%")).toHaveLength(9);
});

test.each([{ rows: [{ label: "Zero", value: 0 }] }, { rows: [{ label: "Negative", value: -4 }] }])("unsuitable pie values retain data instead of inventing a distribution", ({ rows }) => {
  render(<InlineVisualisation vis={vis("pie", rows)} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText(/pie chart needs non-negative values/)).toBeTruthy();
});

test.each([NaN, Infinity, "12", null, {}, undefined])("invalid numeric data is contained in the presentation layer: %s", value => {
  render(<InlineVisualisation vis={vis("bar", [{ label: "Invalid", value }])} />);
  expect(screen.getByRole("status").textContent).toMatch(/cannot be displayed/);
  expect(screen.queryByRole("figure")).toBeNull();
});

test("empty and unknown chart contracts have readable fallbacks", () => {
  const view = render(<InlineVisualisation vis={vis("line", [])} />);
  expect(screen.getByRole("status").textContent).toBe("No chart data is available.");
  view.rerender(<InlineVisualisation vis={vis("unknown")} />);
  expect(screen.getByRole("status").textContent).toMatch(/cannot be displayed/);
});
