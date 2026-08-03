package main

import (
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"

	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

func (s *mockERPService) execute(tool coreregistry.Tool, parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	action := normalizeAction(tool.Name)
	switch {
	case action == "classify_invoice":
		return s.classifyInvoice(parameters)
	case action == "fetch_attendance":
		return s.fetchAttendance(parameters)
	case action == "create_leave":
		return s.createLeave(parameters)
	case strings.Contains(action, "validate_vendor") || strings.Contains(action, "validate_supplier"):
		return s.validateVendor(parameters)
	case strings.Contains(action, "create_purchase_order"):
		return s.createPurchaseOrder(parameters)
	case strings.Contains(action, "get_purchase_order"):
		return s.getPurchaseOrder(parameters)
	case strings.Contains(action, "list_purchase_order"):
		return s.listPurchaseOrders()
	case strings.Contains(action, "record_goods_receipt"):
		return s.recordGoodsReceipt(parameters)
	case strings.Contains(action, "record_invoice_receipt"):
		return s.recordInvoiceReceipt(parameters)
	case strings.Contains(action, "clear_invoice"):
		return s.clearInvoice(parameters)
	case strings.Contains(action, "get_invoice") && !strings.Contains(action, "history"):
		return s.getInvoice(parameters)
	case strings.Contains(action, "list_invoice"):
		return s.listInvoices(parameters)
	case strings.Contains(action, "get_supplier") || strings.Contains(action, "get_vendor"):
		return s.getSupplier(parameters)
	case strings.Contains(action, "list_supplier") || strings.Contains(action, "list_vendor"):
		return s.listSuppliers()
	case strings.Contains(action, "get_employee") && !strings.Contains(action, "cost_center"):
		return s.getEmployee(parameters)
	case strings.Contains(action, "list_employee"):
		return s.listEmployees()
	case strings.Contains(action, "get_cost_centre") || strings.Contains(action, "get_cost_center"):
		return s.getCostCentre(parameters)
	case strings.Contains(action, "list_cost_centre") || strings.Contains(action, "list_cost_center"):
		return s.listCostCentres()
	case strings.Contains(action, "get_stock") || strings.Contains(action, "check_stock"):
		return s.getStock(parameters)
	case strings.Contains(action, "list_stock"):
		return s.listStock()
	default:
		return map[string]interface{}{
			"action":      tool.Name,
			"syntheticId": deterministicID("mock", tool.Name, parameters),
			"status":      "success",
			"parameters":  cloneMapWithoutAction(parameters),
		}, nil
	}
}

func (s *mockERPService) classifyInvoice(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	invoiceID := firstString(parameters, "invoice_id", "invoiceId", "id")
	s.mu.RLock()
	defer s.mu.RUnlock()
	if invoiceID != "" {
		invoice, ok := findInvoice(s.state.Invoices, invoiceID)
		if !ok {
			return nil, notFound("invoice")
		}
		return map[string]interface{}{
			"classification": invoice.Status,
			"invoice":        invoice,
			"status":         "classified",
		}, nil
	}
	counts := map[string]int{}
	for _, invoice := range s.state.Invoices {
		counts[invoice.Status]++
	}
	sample := append([]Invoice{}, s.state.Invoices[:minInt(5, len(s.state.Invoices))]...)
	return map[string]interface{}{"counts": counts, "invoices": sample, "status": "classified"}, nil
}

func (s *mockERPService) fetchAttendance(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	employeeID := firstString(parameters, "employee_id", "employeeId", "id")
	s.mu.RLock()
	defer s.mu.RUnlock()
	employees := s.state.Employees
	if employeeID != "" {
		employee, ok := findEmployee(employees, employeeID)
		if !ok {
			return nil, notFound("employee")
		}
		employees = []Employee{employee}
	} else if len(employees) > 5 {
		employees = employees[:5]
	}
	records := make([]map[string]interface{}, 0, len(employees))
	for index, employee := range employees {
		hours := 8.0
		if index%3 == 2 {
			hours = 7.5
		}
		records = append(records, map[string]interface{}{
			"employeeId": employee.ID,
			"date":       "2026-07-15",
			"hours":      hours,
			"status":     "present",
		})
	}
	return map[string]interface{}{"attendance": records, "count": len(records)}, nil
}

func (s *mockERPService) createLeave(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	employeeID := firstString(parameters, "employee_id", "employeeId")
	if employeeID == "" {
		employeeID = "EMP-001"
	}
	s.mu.RLock()
	_, ok := findEmployee(s.state.Employees, employeeID)
	s.mu.RUnlock()
	if !ok {
		return nil, notFound("employee")
	}
	return map[string]interface{}{
		"leaveRequestId": deterministicID("leave", "create_leave", parameters),
		"employeeId":     employeeID,
		"status":         "submitted",
		"leaveType":      firstNonEmpty(firstString(parameters, "leave_type", "leaveType"), "annual"),
	}, nil
}

func (s *mockERPService) validateVendor(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	vendorID := firstString(parameters, "vendor_id", "vendorId", "supplier_id", "supplierId")
	s.mu.RLock()
	supplier, ok := findSupplier(s.state.Suppliers, vendorID)
	s.mu.RUnlock()
	if !ok {
		return nil, notFound("supplier")
	}
	return map[string]interface{}{
		"vendorId":     supplier.ID,
		"name":         supplier.Name,
		"active":       supplier.Active,
		"paymentTerms": supplier.PaymentTerms,
		"status":       "validated",
	}, nil
}

func (s *mockERPService) createPurchaseOrder(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	vendorID := firstString(parameters, "vendor_id", "vendorId", "supplier_id", "supplierId")
	itemID := firstString(parameters, "item_id", "itemId", "sku")
	quantity, ok := firstInt(parameters, "quantity")
	if !ok || quantity <= 0 {
		return nil, invalid("quantity must be a positive integer")
	}
	requesterID := firstNonEmpty(firstString(parameters, "requester_id", "requesterId"), "EMP-006")
	approverID := firstString(parameters, "approver_id", "approverId")

	s.mu.Lock()
	defer s.mu.Unlock()
	supplier, supplierOK := findSupplier(s.state.Suppliers, vendorID)
	if !supplierOK {
		return nil, notFound("supplier")
	}
	if !supplier.Active {
		return nil, invalid("supplier is inactive")
	}
	stockItem, stockOK := findStock(s.state.Stock, itemID)
	if !stockOK {
		return nil, notFound("stock item")
	}
	if _, employeeOK := findEmployee(s.state.Employees, requesterID); !employeeOK {
		return nil, notFound("requester")
	}
	var approver *string
	if approverID != "" {
		if _, employeeOK := findEmployee(s.state.Employees, approverID); !employeeOK {
			return nil, notFound("approver")
		}
		approver = &approverID
	}
	number := deterministicID("po", "procurement.create_purchase_order", parameters)
	if existing, exists := findPurchaseOrder(s.state.PurchaseOrders, number); exists {
		return map[string]interface{}{"purchaseOrder": existing, "created": false}, nil
	}
	lineTotal := roundMoney(float64(quantity) * stockItem.UnitPrice)
	purchaseOrder := PurchaseOrder{
		Number: number, SupplierID: supplier.ID,
		Items: []PurchaseOrderItem{{
			SKU: stockItem.SKU, Description: stockItem.Description, Quantity: quantity,
			UnitPrice: stockItem.UnitPrice, LineTotal: lineTotal,
		}},
		TotalAmount: lineTotal, Status: "created", RequesterID: requesterID, ApproverID: approver,
	}
	s.state.PurchaseOrders = append(s.state.PurchaseOrders, purchaseOrder)
	return map[string]interface{}{"purchaseOrder": purchaseOrder, "created": true}, nil
}

func (s *mockERPService) getPurchaseOrder(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	number := firstString(parameters, "purchase_order_id", "purchaseOrderId", "number", "id")
	s.mu.RLock()
	purchaseOrder, ok := findPurchaseOrder(s.state.PurchaseOrders, number)
	s.mu.RUnlock()
	if !ok {
		return nil, notFound("purchase order")
	}
	return map[string]interface{}{"purchaseOrder": purchaseOrder}, nil
}

func (s *mockERPService) listPurchaseOrders() (map[string]interface{}, *serviceError) {
	s.mu.RLock()
	items := append([]PurchaseOrder{}, s.state.PurchaseOrders...)
	s.mu.RUnlock()
	return map[string]interface{}{"purchaseOrders": items, "count": len(items)}, nil
}

func (s *mockERPService) recordGoodsReceipt(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	number := firstString(parameters, "purchase_order_id", "purchaseOrderId", "number")
	received, ok := firstInt(parameters, "received_quantity", "receivedQuantity")
	if !ok || received <= 0 {
		return nil, invalid("received_quantity must be a positive integer")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	index := purchaseOrderIndex(s.state.PurchaseOrders, number)
	if index < 0 {
		return nil, notFound("purchase order")
	}
	purchaseOrder := &s.state.PurchaseOrders[index]
	if len(purchaseOrder.Items) == 0 {
		return nil, invalid("purchase order has no items")
	}
	stockIndex := stockItemIndex(s.state.Stock, purchaseOrder.Items[0].SKU)
	if stockIndex < 0 {
		return nil, notFound("stock item")
	}
	s.state.Stock[stockIndex].Quantity += received
	purchaseOrder.ReceivedQty += received
	if purchaseOrder.ReceivedQty >= purchaseOrder.Items[0].Quantity {
		purchaseOrder.Status = "received"
	} else {
		purchaseOrder.Status = "partially_received"
	}
	return map[string]interface{}{
		"purchaseOrder": *purchaseOrder,
		"stock":         s.state.Stock[stockIndex],
		"received":      received,
	}, nil
}

func (s *mockERPService) recordInvoiceReceipt(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	invoiceID := firstString(parameters, "invoice_id", "invoiceId", "id")
	s.mu.Lock()
	defer s.mu.Unlock()
	index := invoiceIndex(s.state.Invoices, invoiceID)
	if index < 0 {
		return nil, notFound("invoice")
	}
	s.state.Invoices[index].ReceiptRecorded = true
	if s.state.Invoices[index].Status == "draft" {
		s.state.Invoices[index].Status = "pending_approval"
	}
	return map[string]interface{}{"invoice": s.state.Invoices[index], "status": "receipt_recorded"}, nil
}

func (s *mockERPService) clearInvoice(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	invoiceID := firstString(parameters, "invoice_id", "invoiceId", "id")
	s.mu.Lock()
	defer s.mu.Unlock()
	index := invoiceIndex(s.state.Invoices, invoiceID)
	if index < 0 {
		return nil, notFound("invoice")
	}
	s.state.Invoices[index].Status = "paid"
	return map[string]interface{}{"invoice": s.state.Invoices[index], "status": "cleared"}, nil
}

func (s *mockERPService) getInvoice(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	invoiceID := firstString(parameters, "invoice_id", "invoiceId", "id")
	s.mu.RLock()
	invoice, ok := findInvoice(s.state.Invoices, invoiceID)
	s.mu.RUnlock()
	if !ok {
		return nil, notFound("invoice")
	}
	return map[string]interface{}{"invoice": invoice}, nil
}

func (s *mockERPService) listInvoices(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	status := firstString(parameters, "status")
	s.mu.RLock()
	items := []Invoice{}
	for _, invoice := range s.state.Invoices {
		if status == "" || strings.EqualFold(invoice.Status, status) {
			items = append(items, invoice)
		}
	}
	s.mu.RUnlock()
	return map[string]interface{}{"invoices": items, "count": len(items)}, nil
}

func (s *mockERPService) getSupplier(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	id := firstString(parameters, "supplier_id", "supplierId", "vendor_id", "vendorId", "id")
	s.mu.RLock()
	item, ok := findSupplier(s.state.Suppliers, id)
	s.mu.RUnlock()
	if !ok {
		return nil, notFound("supplier")
	}
	return map[string]interface{}{"supplier": item}, nil
}

func (s *mockERPService) listSuppliers() (map[string]interface{}, *serviceError) {
	s.mu.RLock()
	items := append([]Supplier{}, s.state.Suppliers...)
	s.mu.RUnlock()
	return map[string]interface{}{"suppliers": items, "count": len(items)}, nil
}

func (s *mockERPService) getEmployee(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	id := firstString(parameters, "employee_id", "employeeId", "id")
	s.mu.RLock()
	item, ok := findEmployee(s.state.Employees, id)
	s.mu.RUnlock()
	if !ok {
		return nil, notFound("employee")
	}
	return map[string]interface{}{"employee": item}, nil
}

func (s *mockERPService) listEmployees() (map[string]interface{}, *serviceError) {
	s.mu.RLock()
	items := append([]Employee{}, s.state.Employees...)
	s.mu.RUnlock()
	return map[string]interface{}{"employees": items, "count": len(items)}, nil
}

func (s *mockERPService) getCostCentre(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	code := firstString(parameters, "cost_centre", "costCentre", "cost_center", "costCenter", "code")
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, item := range s.state.CostCentres {
		if strings.EqualFold(item.Code, code) {
			return map[string]interface{}{"costCentre": item}, nil
		}
	}
	return nil, notFound("cost centre")
}

func (s *mockERPService) listCostCentres() (map[string]interface{}, *serviceError) {
	s.mu.RLock()
	items := append([]CostCentre{}, s.state.CostCentres...)
	s.mu.RUnlock()
	return map[string]interface{}{"costCentres": items, "count": len(items)}, nil
}

func (s *mockERPService) getStock(parameters map[string]interface{}) (map[string]interface{}, *serviceError) {
	sku := firstString(parameters, "sku", "item_id", "itemId", "id")
	s.mu.RLock()
	item, ok := findStock(s.state.Stock, sku)
	s.mu.RUnlock()
	if !ok {
		return nil, notFound("stock item")
	}
	return map[string]interface{}{"stock": item}, nil
}

func (s *mockERPService) listStock() (map[string]interface{}, *serviceError) {
	s.mu.RLock()
	items := append([]StockItem{}, s.state.Stock...)
	s.mu.RUnlock()
	return map[string]interface{}{"stock": items, "count": len(items)}, nil
}

func findSupplier(items []Supplier, id string) (Supplier, bool) {
	for _, item := range items {
		if strings.EqualFold(item.ID, id) {
			return item, true
		}
	}
	return Supplier{}, false
}

func findInvoice(items []Invoice, id string) (Invoice, bool) {
	for _, item := range items {
		if strings.EqualFold(item.ID, id) || strings.EqualFold(item.Number, id) {
			return item, true
		}
	}
	return Invoice{}, false
}

func findPurchaseOrder(items []PurchaseOrder, number string) (PurchaseOrder, bool) {
	index := purchaseOrderIndex(items, number)
	if index < 0 {
		return PurchaseOrder{}, false
	}
	return items[index], true
}

func findStock(items []StockItem, sku string) (StockItem, bool) {
	index := stockItemIndex(items, sku)
	if index < 0 {
		return StockItem{}, false
	}
	return items[index], true
}

func findEmployee(items []Employee, id string) (Employee, bool) {
	for _, item := range items {
		if strings.EqualFold(item.ID, id) {
			return item, true
		}
	}
	return Employee{}, false
}

func invoiceIndex(items []Invoice, id string) int {
	for index, item := range items {
		if strings.EqualFold(item.ID, id) || strings.EqualFold(item.Number, id) {
			return index
		}
	}
	return -1
}

func purchaseOrderIndex(items []PurchaseOrder, number string) int {
	for index, item := range items {
		if strings.EqualFold(item.Number, number) {
			return index
		}
	}
	return -1
}

func stockItemIndex(items []StockItem, sku string) int {
	for index, item := range items {
		if strings.EqualFold(item.SKU, sku) {
			return index
		}
	}
	return -1
}

func firstString(parameters map[string]interface{}, names ...string) string {
	for _, name := range names {
		if value, ok := parameters[name]; ok {
			if result := strings.TrimSpace(fmt.Sprint(value)); result != "" && result != "<nil>" {
				return result
			}
		}
	}
	return ""
}

func firstInt(parameters map[string]interface{}, names ...string) (int, bool) {
	for _, name := range names {
		value, ok := parameters[name]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case float64:
			if math.Trunc(typed) == typed {
				return int(typed), true
			}
		case int:
			return typed, true
		case string:
			parsed, err := strconv.Atoi(typed)
			if err == nil {
				return parsed, true
			}
		}
	}
	return 0, false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func roundMoney(value float64) float64 {
	return math.Round(value*100) / 100
}

func invalid(message string) *serviceError {
	return &serviceError{Status: http.StatusBadRequest, Category: "INVALID_REQUEST", Message: message}
}

func notFound(resource string) *serviceError {
	return &serviceError{Status: http.StatusNotFound, Category: "NOT_FOUND", Message: resource + " not found"}
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func sortedKeys(input map[string]int) []string {
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
