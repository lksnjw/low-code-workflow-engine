/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
let grants,route;const navigateTo=jest.fn(),setActiveSub=jest.fn();
jest.unstable_mockModule("../../config/app",()=>({appConfig:{pipelineUploadEnabled:true}}));
jest.unstable_mockModule("../../context/RouteContext",()=>({useRoute:()=>({...route,navigateTo,setActiveSub})}));
jest.unstable_mockModule("../../hooks/usePermissions",()=>({default:()=>({hasAny:needed=>needed.some(item=>grants.includes(item)),roleId:"qa"})}));
const {default:MobileNav}=await import("./MobileNav");const {default:Sidebar}=await import("./Sidebar");
const {default:DataTable}=await import("../shared/tables/DataTable");
beforeEach(()=>{grants=["chat:use","pipeline:upload","settings:manage"];route={activeMain:"pipeline_upload",activeSub:"upload"};navigateTo.mockClear();setActiveSub.mockClear();});afterEach(cleanup);
test("secondary pages are reachable without the desktop sidebar",()=>{render(<MobileNav/>);const pages=screen.getByRole("navigation",{name:"Data Ingestion pages"});fireEvent.click(within(pages).getByRole("button",{name:"Indexed Data Chat"}));expect(navigateTo).toHaveBeenCalledWith("pipeline_upload","chat");expect(within(pages).getByRole("button",{name:"Files & Documents"})).toHaveAttribute("aria-current","page");});
test("navigation never offers an upload page without permission",()=>{grants=["chat:use"];render(<MobileNav/>);expect(screen.queryByRole("button",{name:"Files & Documents"})).toBeNull();});
test("desktop sidebar search filters actual pages and explains no results",()=>{route={activeMain:"settings",activeSub:"general"};render(<MemoryRouter><Sidebar/></MemoryRouter>);const search=screen.getByRole("searchbox",{name:"Search Settings pages"});fireEvent.change(search,{target:{value:"integration"}});expect(screen.getByRole("button",{name:"Integrations"})).toBeTruthy();expect(screen.queryByRole("button",{name:"General",exact:true})).toBeNull();fireEvent.change(search,{target:{value:"no-such-page"}});expect(screen.getByRole("status")).toHaveTextContent("No matching pages");});

test.each(["workflow:read", "workflow:read_own", "execution:read_own", "chat:use"])("top-left Dashboard keeps its permission boundary for %s", permission => {
  grants = [permission];
  render(<MemoryRouter><Sidebar /></MemoryRouter>);
  const dashboard = screen.queryByRole("link", { name: "Dashboard", exact: true });
  expect(Boolean(dashboard)).toBe(permission !== "chat:use");
  if (dashboard) {
    expect(dashboard).toHaveAttribute("href", "/dashboard");
    const groupButton = screen.getByRole("button", { name: "Company", exact: true });
    expect(dashboard.compareDocumentPosition(groupButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});

test("Dashboard remains reachable at the top of a collapsed sidebar and marks its active route", () => {
  grants = ["workflow:read_own"];
  render(<MemoryRouter initialEntries={["/dashboard"]}><Sidebar isCollapsed /></MemoryRouter>);
  expect(screen.getByRole("link", { name: "Dashboard", exact: true })).toHaveAttribute("aria-current", "page");
});
test("tables expose a focusable horizontal region and scoped headers",()=>{render(<DataTable label="ERP records" columns={[{key:"name",label:"Name"}]} rows={[{id:"one",name:"Invoice"}]}/>);expect(screen.getByRole("region",{name:"ERP records"})).toHaveAttribute("tabindex","0");expect(screen.getByRole("region",{name:"ERP records"})).toHaveClass("overflow-x-auto");expect(screen.getByRole("columnheader")).toHaveAttribute("scope","col");});
