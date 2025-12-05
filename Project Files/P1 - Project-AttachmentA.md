# 📦 Project: Attachment A Rollout

**Purpose:** To solidify explicit inventory coverage for items we're stocking by developing and sending the new *Attachment A* notification to our top customers that takes into account supplier LT, customer usage, and items stocked at suppliers.
**Inclusion Rule:** Any open or new item containing “Attachment A” automatically falls under this project.  
**Status:** Active

---

## Phases & Tasks

### Phase 1: Define Scope & Customer List

- [x] Create Attachment A rollout tracker listing all target customers and planned send dates. *(Source list pulled from Power BI.)*
- [x] Schedule meeting with Chris for week of 11/10 to review plan & progress

### Phase 2: Finalize and Refine Attachment A Content & Format

- [x] @Zach  will pull Karla's Cost Savings Smarsheet into Attachment A template.
- + Create logic to use "Cold Start LT" instead of published LT for supplier stocked parts. #P1
- + Confirm versioning and storage location. (Where will it be kept? Date reference is probably ok.)
- + Establish logic for “Lead Time to Customer” column on the customer copy.
    *I recommend we use the placeholder "transit", but we need to be sensitive to what looks best to most customers*
- + Update Attachment A datasource to the report server (per Chad)

### Phase 3: Finalize Attachment A Process, ownership, & Work Instructions

- + Document each step for creating, updating, and sending the Attachment A.
- + Define ownership, create work instructions, and store alongside the master template.(Mike, Jake, Melissa) #P1

### Phase 4: Pilot Rollout to Select Accounts

- + Meet with sales reps to explain the new process and outline how the initial rollout will go.
- + Send Attachment A notification with clear messaging.
- + Capture reactions and adjust template or messaging.

### Phase 5: Full Rollout to Top Customers

- + Schedule communication cadence and track confirmations.

### Phase 6: Follow-up & Tracking Metrics

- + Verify acknowledgment, record confirmations, summarize coverage, and note next steps.
- + Establish next evolution of Attachment A to include all customer Xref parts and note which items Field is not stocking (no price, cold start lead time, no commitment).

## Tweaking the Sheet

1. Zach now pulled in the Smartsheet with old LTs
2. Hesitation on creating a new LT Field--even if it's non-audit trail.
3. Add a disclaimer about qtys being subject to change being MOQs
4. Add a disclaimer about how these qtys do not include previously identified commitments on specific items
## Building the Process

1. Let's confirm if I have this right:
      1. Automation to produce report (Do I have to get with Stephanie?)
      2. Send to AMs & Sales to review the first few times, but it will always go out automatically after the first few times.
## Initial Rollout Process

1. Tracker is built, top 50 are selected
2. Decide if automation can work the initial rollout
      + [] meet with Zach and Steph on workado. Can it automate the Attachment A rollout?
3. Need to do internal meetings
      - Meet with Jake & Melissa to solidify AMs part of the role
      - Meet with Sales reps to tell them about the process.
      - Meet with Gregg & Pauli on the verbiage & format 



## Future

1. Pull in stockable check mark.
2. Change to start with ALL customer xref parts
3. Make it so that the AM gets 4 weeks to review the Att. A and object to it, or it automatically gets sent out.
4. Inventory report on a customer dashboard rather thant being sent out.
---

## Notes

- Need Lead time integrity in P21 that pulls in through contract queries
  
     - Karla would love "Cold Start LT" for items in stocking programs.

- Karla Sent Zach the Supplier stocking Smartsheet

- P21 update process
  
     - Once a contract is agreed to with supplier STOCKING is checked in P21
  
     - Once we get confirmation from supplier that they're ready to ship, the PUBLISHED LT is updated

- Further benefit of "Cold Start LT": BBI & Lindstrom, etc. parts would benefit
