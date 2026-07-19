import { create } from "zustand";

export const useWorkflowStore = create((set) => ({
	workflows: [],
  setWorkflows: (nextWorkflows) => set({ workflows: nextWorkflows }),
}));
