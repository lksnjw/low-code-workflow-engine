const variants = {
  primary: "bg-primary text-white hover:bg-primary/90",
  secondary:
    "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-darkBackground dark:text-gray-200 dark:hover:bg-darkBackgroundVery",
  ghost:
    "text-gray-600 hover:bg-gray-100 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-black dark:hover:text-white",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

/*******************************************************************************
 * Function: Button
 *
 * Performs the Button operation on the application for the Button module.
 ******************************************************************************/
function Button({ children, variant = "primary", className = "", type = "button", ...props }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-darkBackground ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export default Button;
