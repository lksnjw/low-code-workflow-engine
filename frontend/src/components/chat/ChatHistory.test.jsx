/** @jest-environment jsdom */
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatHistory from "./ChatHistory";
afterEach(cleanup);

test("another owner's reviewable chat can be opened but has no rename/delete actions", () => {
  const open = jest.fn(); render(<ChatHistory sessions={[{ id: "other", title: "Administrative review", access: { canManage: false } }]} onSelect={open} />);
  fireEvent.click(screen.getByRole("button", { name: "Administrative review" })); expect(open).toHaveBeenCalledWith("other");
  expect(screen.queryByTitle("Rename")).toBeNull(); expect(screen.queryByTitle("Delete")).toBeNull();
});

test("a list changed by concurrent conversations does not falsely claim all history is loaded", () => {
  const refresh = jest.fn(); render(<ChatHistory sessions={[{ id: "one", title: "Saved conversation" }]} total={3} hasMore={false} onRetry={refresh} />);
  expect(screen.queryByText(/All conversations loaded/)).toBeNull(); expect(screen.getByText(/conversation list changed while loading/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh conversation list" })); expect(refresh).toHaveBeenCalledTimes(1);
});
test("new-conversation failure is visible and does not lose saved chats",async()=>{const onCreate=jest.fn().mockRejectedValue(new Error("offline"));render(<ChatHistory sessions={[]} onCreate={onCreate}/>);fireEvent.click(screen.getByRole("button",{name:"New conversation"}));expect((await screen.findByRole("alert")).textContent).toContain("Could not start a conversation");expect(onCreate).toHaveBeenCalledTimes(1);});
test("older-list retry and end-of-history states are explicit",async()=>{const onLoadMore=jest.fn();const view=render(<ChatHistory sessions={[]} hasMore onLoadMore={onLoadMore} loadMoreError="Earlier chats unavailable"/>);fireEvent.click(screen.getByRole("button",{name:"Load older conversations"}));await waitFor(()=>expect(onLoadMore).toHaveBeenCalledTimes(1));expect(screen.getByRole("alert").textContent).toBe("Earlier chats unavailable");view.rerender(<ChatHistory sessions={[{id:"one",title:"Saved ERP review"}]} total={1} hasMore={false}/>);expect(screen.getByText(/All conversations loaded/)).toBeTruthy();expect(screen.queryByRole("button",{name:"Load older conversations"})).toBeNull();});
