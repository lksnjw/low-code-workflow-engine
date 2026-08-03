package main

import "time"

type Supplier struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Category     string `json:"category"`
	PaymentTerms string `json:"paymentTerms"`
	Active       bool   `json:"active"`
	TaxID        string `json:"taxId"`
	ContactEmail string `json:"contactEmail"`
}

type Invoice struct {
	ID              string  `json:"id"`
	SupplierID      string  `json:"supplierId"`
	Number          string  `json:"number"`
	Amount          float64 `json:"amount"`
	Currency        string  `json:"currency"`
	Status          string  `json:"status"`
	InvoiceDate     string  `json:"invoiceDate"`
	DueDate         string  `json:"dueDate"`
	ReceiptRecorded bool    `json:"receiptRecorded"`
}

type PurchaseOrderItem struct {
	SKU         string  `json:"sku"`
	Description string  `json:"description"`
	Quantity    int     `json:"quantity"`
	UnitPrice   float64 `json:"unitPrice"`
	LineTotal   float64 `json:"lineTotal"`
}

type PurchaseOrder struct {
	Number      string              `json:"number"`
	SupplierID  string              `json:"supplierId"`
	Items       []PurchaseOrderItem `json:"items"`
	TotalAmount float64             `json:"totalAmount"`
	Status      string              `json:"status"`
	RequesterID string              `json:"requesterId"`
	ApproverID  *string             `json:"approverId"`
	ReceivedQty int                 `json:"receivedQuantity,omitempty"`
}

type StockItem struct {
	SKU         string  `json:"sku"`
	Description string  `json:"description"`
	Warehouse   string  `json:"warehouse"`
	Quantity    int     `json:"quantity"`
	UnitPrice   float64 `json:"unitPrice"`
}

type Employee struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	ManagerID  *string `json:"managerId"`
	Department string  `json:"department"`
	Role       string  `json:"role"`
	Active     bool    `json:"active"`
}

type CostCentre struct {
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	Allocated float64 `json:"allocated"`
	Spent     float64 `json:"spent"`
	Remaining float64 `json:"remaining"`
	OwnerID   string  `json:"ownerId"`
}

type fixtureState struct {
	Suppliers      []Supplier
	Invoices       []Invoice
	PurchaseOrders []PurchaseOrder
	Stock          []StockItem
	Employees      []Employee
	CostCentres    []CostCentre
}

type executeRequest struct {
	Action     string                 `json:"action"`
	Parameters map[string]interface{} `json:"parameters"`
}

type RequestRecord struct {
	Sequence        int                    `json:"sequence"`
	Timestamp       time.Time              `json:"timestamp"`
	Action          string                 `json:"action"`
	CanonicalAction string                 `json:"canonicalAction"`
	Parameters      map[string]interface{} `json:"parameters"`
	StatusCode      int                    `json:"statusCode"`
	Outcome         string                 `json:"outcome"`
}

type mockERPConfig struct {
	MinLatency time.Duration
	MaxLatency time.Duration
	FailTool   string
	FailMode   string
}

type serviceError struct {
	Status   int
	Category string
	Message  string
}

func (e *serviceError) Error() string {
	return e.Message
}
