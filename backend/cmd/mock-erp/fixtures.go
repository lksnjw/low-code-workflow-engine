package main

import (
	"embed"
	"encoding/json"
	"fmt"
)

//go:embed fixtures/*.json
var fixtureFiles embed.FS

func loadFixtureState() (fixtureState, error) {
	var state fixtureState
	targets := []struct {
		path   string
		target interface{}
	}{
		{"fixtures/suppliers.json", &state.Suppliers},
		{"fixtures/invoices.json", &state.Invoices},
		{"fixtures/purchase_orders.json", &state.PurchaseOrders},
		{"fixtures/stock.json", &state.Stock},
		{"fixtures/employees.json", &state.Employees},
		{"fixtures/cost_centres.json", &state.CostCentres},
	}
	for _, item := range targets {
		raw, err := fixtureFiles.ReadFile(item.path)
		if err != nil {
			return fixtureState{}, fmt.Errorf("read %s: %w", item.path, err)
		}
		if err := json.Unmarshal(raw, item.target); err != nil {
			return fixtureState{}, fmt.Errorf("decode %s: %w", item.path, err)
		}
	}
	if err := validateFixtureReferences(state); err != nil {
		return fixtureState{}, err
	}
	return state, nil
}

func validateFixtureReferences(state fixtureState) error {
	suppliers := map[string]bool{}
	employees := map[string]bool{}
	stock := map[string]bool{}
	for _, supplier := range state.Suppliers {
		suppliers[supplier.ID] = true
	}
	for _, employee := range state.Employees {
		employees[employee.ID] = true
	}
	for _, item := range state.Stock {
		stock[item.SKU] = true
	}
	for _, employee := range state.Employees {
		if employee.ManagerID != nil && !employees[*employee.ManagerID] {
			return fmt.Errorf("employee %s references missing manager %s", employee.ID, *employee.ManagerID)
		}
	}
	for _, invoice := range state.Invoices {
		if !suppliers[invoice.SupplierID] {
			return fmt.Errorf("invoice %s references missing supplier %s", invoice.ID, invoice.SupplierID)
		}
	}
	for _, purchaseOrder := range state.PurchaseOrders {
		if !suppliers[purchaseOrder.SupplierID] {
			return fmt.Errorf("purchase order %s references missing supplier %s", purchaseOrder.Number, purchaseOrder.SupplierID)
		}
		if !employees[purchaseOrder.RequesterID] {
			return fmt.Errorf("purchase order %s references missing requester %s", purchaseOrder.Number, purchaseOrder.RequesterID)
		}
		if purchaseOrder.ApproverID != nil && !employees[*purchaseOrder.ApproverID] {
			return fmt.Errorf("purchase order %s references missing approver %s", purchaseOrder.Number, *purchaseOrder.ApproverID)
		}
		for _, item := range purchaseOrder.Items {
			if !stock[item.SKU] {
				return fmt.Errorf("purchase order %s references missing stock item %s", purchaseOrder.Number, item.SKU)
			}
		}
	}
	for _, costCentre := range state.CostCentres {
		if !employees[costCentre.OwnerID] {
			return fmt.Errorf("cost centre %s references missing owner %s", costCentre.Code, costCentre.OwnerID)
		}
		if costCentre.Allocated-costCentre.Spent != costCentre.Remaining {
			return fmt.Errorf("cost centre %s has inconsistent remaining balance", costCentre.Code)
		}
	}
	return nil
}
