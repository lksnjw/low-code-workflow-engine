/*******************************************************************************
 * Function: Avatar
 *
 * Performs the Avatar operation on the application for the Avatar module.
 ******************************************************************************/
function Avatar({ initials = "AW", className = "" }) {
  return (
    <span
      className={`flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-bold text-white ${className}`}
    >
      {initials}
    </span>
  );
}

export default Avatar;
