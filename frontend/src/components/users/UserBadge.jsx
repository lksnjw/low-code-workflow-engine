/*******************************************************************************
 * Function: UserBadge
 *
 * Performs the User Badge operation on badge for the UserBadge module.
 ******************************************************************************/
function UserBadge({ children }) {
  return (
    <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary">
      {children}
    </span>
  );
}

export default UserBadge;
