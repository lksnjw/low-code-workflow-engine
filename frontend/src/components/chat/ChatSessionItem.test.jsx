/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatSessionItem from "./ChatSessionItem";
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

test("saved preview is visible without downloading or expanding conversation messages",()=>{
  const open=jest.fn();render(<ChatSessionItem id="chat-preview" title="Customer registration" summary="Reviewed the required customer details" onClick={open}/>);
  expect(screen.getByText("Reviewed the required customer details")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:/Customer registration Reviewed the required customer details/}));expect(open).toHaveBeenCalledTimes(1);
});

test("history actions exist without a mouse hover, and Escape never saves a rename", () => {
  const rename = jest.fn(); render(<ChatSessionItem id="chat-1" title="Saved chat" onRename={rename} />);
  expect(screen.getByTitle("Delete")).toBeTruthy();
  fireEvent.click(screen.getByTitle("Rename"));
  const input = screen.getByRole("textbox", { name: "Conversation title" });
  fireEvent.change(input, { target: { value: "Do not save" } });
  fireEvent.keyDown(input, { key: "Escape" }); fireEvent.blur(input);
  expect(rename).not.toHaveBeenCalled(); expect(screen.queryByRole("textbox")).toBeNull();
});

test("one pending rename cannot be duplicated by Enter plus blur", async () => {
  let finish; const rename = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  render(<ChatSessionItem id="chat-1" title="Saved chat" onRename={rename} />);
  fireEvent.click(screen.getByTitle("Rename")); const input = screen.getByRole("textbox", { name: "Conversation title" });
  fireEvent.change(input, { target: { value: "  Reviewed chat  " } });
  fireEvent.keyDown(input, { key: "Enter" }); fireEvent.blur(input); fireEvent.keyDown(input, { key: "Enter" });
  expect(rename).toHaveBeenCalledTimes(1); expect(rename).toHaveBeenCalledWith("chat-1", "Reviewed chat");
  finish(); await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
});

test("failed rename is visible, keeps the entered title and permits explicit retry", async () => {
  const rename = jest.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({});
  render(<ChatSessionItem id="chat-1" title="Saved chat" onRename={rename} />);
  fireEvent.click(screen.getByTitle("Rename")); const input = screen.getByRole("textbox", { name: "Conversation title" });
  fireEvent.change(input, { target: { value: "Reviewed chat" } }); fireEvent.keyDown(input, { key: "Enter" });
  expect((await screen.findByRole("alert")).textContent).toContain("Your entered title is kept");
  expect(input.value).toBe("Reviewed chat");
  fireEvent.keyDown(input, { key: "Enter" }); await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(rename).toHaveBeenCalledTimes(2);
});

test("delete cancellation never calls the API; a rejected delete is caught and shown", async () => {
  const remove = jest.fn().mockRejectedValue(new Error("Offline"));
  jest.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<ChatSessionItem id="chat-1" title="Saved chat" onDelete={remove} />);
  fireEvent.click(screen.getByTitle("Delete")); expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTitle("Delete"));
  expect((await screen.findByRole("alert")).textContent).toContain("Reload history to confirm"); expect(remove).toHaveBeenCalledTimes(1);
});
