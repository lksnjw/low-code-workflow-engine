import { createElement } from "react";

/*******************************************************************************
 * Function: Card
 *
 * Performs the Card operation on the application for the Card module.
 ******************************************************************************/
function Card({ children, className = "", as = "section", ...props }) {
  return createElement(as, { className: `surface-panel rounded-2xl p-5 ${className}`, ...props }, children);
}

export default Card;
