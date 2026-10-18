// FsOrderLedger models an event-sourced order service: placed orders, an in-process event bus,
// undo history, a forever-growing quote cache, a mailbox audit trail and rejection capture.
// It is the memory/leak profiling target: every command retains state that only `release` frees.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

namespace FsOrderLedger

open System

/// Single-case union, deliberately NOT a struct: each customer id is its own heap object.
type CustomerId = CustomerId of int

[<Struct>]
type Address = { Street: string; Postcode: int }

[<Struct>]
type Money = Cents of int64

type OrderLine = { Sku: string; Quantity: int; UnitPrice: Money }

type OrderStatus =
    | Pending
    | Paid of paymentRef: string
    | Shipped of carrier: string * tracking: string
    | Cancelled of reason: string

type Order =
    { Id: int
      Customer: CustomerId
      ShipTo: Address
      Lines: OrderLine list
      Status: OrderStatus
      Payload: byte array }

type Versioned<'T> = { Version: int; Value: 'T }

type AuditEntry = { At: DateTime; OrderId: int; Note: string }

exception OrderRejected of orderId: int * reason: string

type Quote = { Sku: string; Price: decimal; Tags: Set<string> }
