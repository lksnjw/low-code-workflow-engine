import { createElement } from "react";

function Card({ children, className = "", as = "section", ...props }) {
  return createElement(as, { className: `surface-panel rounded-2xl p-5 ${className}`, ...props }, children);
}

export default Card;
