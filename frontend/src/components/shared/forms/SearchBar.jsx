import Input from "../ui/Input";

/*******************************************************************************
 * Function: SearchBar
 *
 * Performs the Search Bar operation on bar for the SearchBar module.
 ******************************************************************************/
function SearchBar(props) {
  return <Input type="search" placeholder="Search..." {...props} />;
}

export default SearchBar;
