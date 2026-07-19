import { useState } from "react";

export function useWorkflowBuilder(initialNodes = []) {
  const [nodes, setNodes] = useState(initialNodes);
  return { nodes, setNodes, addNode: (node) => setNodes((items) => [...items, node]) };
}

export default useWorkflowBuilder;
