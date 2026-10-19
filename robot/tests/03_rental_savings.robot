*** Settings ***
Documentation     Rental income (with the loan) and savings (with the target and sub-targets).
Resource          ../resources/common.resource
Suite Setup       Open Test Browser
Suite Teardown    Close All Browsers
Test Setup        Start Signed In
Test Timeout      60s
Force Tags        goals

*** Keywords ***
Start Signed In
    Reset App
    Log In Successfully

Add Rental Record
    [Arguments]    ${income}    ${expense}=${EMPTY}    ${details}=${EMPTY}
    Open Tab    rental
    Input Text    id:rentalIncome    ${income}
    Input Text    id:rentalExpense    ${expense}
    Input Text    id:rentalExpenseDesc    ${details}
    Click Button    id:rentalSubmit

*** Test Cases ***
Adding A Rental Record Reduces The Loan Balance
    Add Rental Record    5000    500    Plumbing
    Wait Until Element Contains    id:totalRent    5000.00 DHS
    Wait Until Element Contains    id:totalRentalExpenses    500.00 DHS
    Wait Until Element Contains    id:loanBalance    65500.00 DHS
    Wait Until Element Contains    id:loanProgress    6.4%
    Toast Should Say    Rental record saved
    Page Should Contain    Plumbing

A Rental Record Without Any Amount Is Rejected
    Open Tab    rental
    Click Button    id:rentalSubmit
    Dialog Should Say    income or an expense

A Rental Record Can Be Edited And Its Month Stays Locked
    Add Rental Record    5000    500
    Wait Until Element Contains    id:loanBalance    65500.00 DHS
    Click Button    css:#rentalTable .edit-btn
    Element Should Be Disabled    id:rentalMonth
    Input Text    id:rentalIncome    6000
    Click Button    id:rentalSubmit
    Wait Until Element Contains    id:loanBalance    64500.00 DHS
    Toast Should Say    Rental record updated
    Element Should Be Enabled    id:rentalMonth

The Loan Amount Can Be Changed
    Add Rental Record    5000    500
    Wait Until Element Contains    id:loanBalance    65500.00 DHS
    Input Text    id:loanAmountInput    20000
    Click Button    id:loanSubmit
    Wait Until Element Contains    id:loanBalance    15500.00 DHS
    Toast Should Say    Loan amount updated

An Invalid Loan Amount Is Rejected
    Open Tab    rental
    Input Text    id:loanAmountInput    0
    Click Button    id:loanSubmit
    Dialog Should Say    greater than 0

Rental Records Can Be Reset To Start Over With A New Loan
    Add Rental Record    5000    500
    Wait Until Element Contains    id:loanBalance    65500.00 DHS
    Input Text    id:loanAmountInput    30000
    Click Button    id:loanSubmit
    Wait Until Element Contains    id:loanBalance    25500.00 DHS
    Click Button    id:resetRentalBtn
    ${message}=    Accept Dialog
    Should Contain    ${message}    Delete ALL 1 rental records
    Wait Until Element Contains    id:rentalTable    No rental records yet
    Wait Until Element Contains    id:loanBalance    30000.00 DHS
    Element Should Be Disabled    id:resetRentalBtn

A Rental Reset Can Be Cancelled
    Add Rental Record    5000    500
    Wait Until Element Contains    id:loanBalance    65500.00 DHS
    Click Button    id:resetRentalBtn
    Dismiss Dialog
    Element Should Contain    id:totalRent    5000.00 DHS

Recording Savings Updates The Totals And Progress
    Open Tab    savings
    Click Button    id:savingsSubmit
    Wait Until Element Contains    id:totalSaved    2000.00 DHS
    Wait Until Element Contains    id:monthsCompleted    1 / 13
    Wait Until Element Contains    id:remainingSavings    24000.00 DHS
    Toast Should Say    Savings recorded

A Savings Record Can Be Edited And Its Month Stays Locked
    Open Tab    savings
    Click Button    id:savingsSubmit
    Wait Until Element Contains    id:totalSaved    2000.00 DHS
    Click Button    css:#savingsTable .edit-btn
    Element Should Be Disabled    id:savingsMonth
    Input Text    id:savingsAmount    3000
    Click Button    id:savingsSubmit
    Wait Until Element Contains    id:totalSaved    3000.00 DHS
    Toast Should Say    Savings record updated

The Savings Target Can Be Changed
    Open Tab    savings
    Click Button    id:savingsSubmit
    Wait Until Element Contains    id:totalSaved    2000.00 DHS
    Input Text    id:savingsTargetInput    10000
    Click Button    id:goalSubmit
    Wait Until Element Contains    id:savingsTargetDisplay    10000.00 DHS
    Wait Until Element Contains    id:remainingSavings    8000.00 DHS
    Toast Should Say    Savings target updated

A Sub-target Is Tracked Before The Main Target
    Open Tab    savings
    Click Button    id:savingsSubmit
    Wait Until Element Contains    id:totalSaved    2000.00 DHS
    Input Text    id:milestoneName    Emergency fund
    Input Text    id:milestoneAmount    5000
    Click Button    id:milestoneSubmit
    Wait Until Element Contains    id:milestoneList    Emergency fund
    Wait Until Element Contains    id:nextMilestone    3000.00 DHS to go
    Page Should Contain Element    css:#savingsProgressBar .marker

A Sub-target Must Be Below The Main Target
    Open Tab    savings
    Input Text    id:milestoneName    Too big
    Input Text    id:milestoneAmount    26000
    Click Button    id:milestoneSubmit
    Dialog Should Say    lower than the main target

A Sub-target Can Be Edited And Deleted
    Open Tab    savings
    Input Text    id:milestoneName    Holiday
    Input Text    id:milestoneAmount    8000
    Click Button    id:milestoneSubmit
    Wait Until Element Contains    id:milestoneList    Holiday
    Click Button    css:#milestoneList .edit-btn
    Input Text    id:milestoneAmount    9000
    Click Button    id:milestoneSubmit
    Wait Until Element Contains    id:milestoneList    9000.00 DHS
    Click Button    css:#milestoneList .delete-btn
    Accept Dialog
    Wait Until Element Does Not Contain    id:milestoneList    Holiday

Savings Records Can Be Reset While Keeping The Sub-targets
    Open Tab    savings
    Click Button    id:savingsSubmit
    Wait Until Element Contains    id:totalSaved    2000.00 DHS
    Input Text    id:milestoneName    Holiday
    Input Text    id:milestoneAmount    8000
    Click Button    id:milestoneSubmit
    Wait Until Element Contains    id:milestoneList    Holiday
    Click Button    id:resetSavingsBtn
    Accept Dialog
    Wait Until Element Contains    id:savingsTable    No savings recorded yet
    Wait Until Element Contains    id:totalSaved    0.00 DHS
    Element Should Contain    id:milestoneList    Holiday
