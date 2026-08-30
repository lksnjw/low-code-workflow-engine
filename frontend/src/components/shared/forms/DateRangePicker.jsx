import Input from "../ui/Input";

/*******************************************************************************
 * Function: DateRangePicker
 *
 * Performs the Date Range Picker operation on range picker for the DateRangePicker module.
 ******************************************************************************/
function DateRangePicker() {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Input type="date" />
      <Input type="date" />
    </div>
  );
}

export default DateRangePicker;
