import { create } from "zustand";

export const useCanvasStore = create((set) => ({
	nodes: [],
	selectedNodeId: null,
	setNodes: (nodes) => set({ nodes }),
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
}));
