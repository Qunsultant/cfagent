### Fixed

- Order preview modal names the selected broker (#3420): "Legs sent to …", the upstream-session label, the commission disclosure and the approve button all read the broker the order actually goes to, so an Alpaca tenant is no longer asked to "Approve & Submit Trade to E*TRADE".
- The OAuth/error banner is titled with the selected broker (#3420). The banner also carries a broker READ failure, so an Alpaca positions error used to appear under "E*TRADE connection".
- The screening failure sentence names the selected broker (#3420).

### Unchanged (deliberately)

- E*TRADE's own OAuth redirect, PIN and REST-diagnostics copy keeps E*TRADE's name (#3420). Those describe a flow only E*TRADE has; neutralising them would tell another broker's tenant to enter a PIN that does not exist. The hub already refuses diagnostics for other brokers through `diagnosticsEndpoint()`.
