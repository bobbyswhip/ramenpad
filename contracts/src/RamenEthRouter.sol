// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {IUniswapV2Router02} from "./interfaces/IUniswapV2Router02.sol";

interface IRamenTokenBuyer {
    function buy(address token, uint256 ramenIn, uint256 minTokenOut, address recipient)
        external
        returns (uint256 tokenOut);
}

/// @notice Stateless one-transaction ETH -> RAMEN -> launched-token router.
contract RamenEthRouter {
    IUniswapV2Router02 public immutable v2Router;
    address public immutable weth;
    address public immutable ramen;
    IRamenTokenBuyer public immutable tokenRouter;
    bool private entered;

    event EthBuy(
        address indexed token,
        address indexed buyer,
        address indexed recipient,
        uint256 ethIn,
        uint256 ramenIn,
        uint256 tokenOut
    );

    error InvalidAddress();
    error InvalidAmount();
    error TransferFailed();
    error Reentrancy();

    constructor(address v2Router_, address weth_, address ramen_, address tokenRouter_) {
        if (v2Router_ == address(0) || weth_ == address(0) || ramen_ == address(0) || tokenRouter_ == address(0)) {
            revert InvalidAddress();
        }
        v2Router = IUniswapV2Router02(v2Router_);
        weth = weth_;
        ramen = ramen_;
        tokenRouter = IRamenTokenBuyer(tokenRouter_);
    }

    function buyWithEth(address token, uint256 minTokenOut, address recipient, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 ramenIn, uint256 tokenOut)
    {
        if (msg.value == 0) revert InvalidAmount();
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = ramen;
        uint256 beforeBalance = IERC20(ramen).balanceOf(address(this));
        v2Router.swapExactETHForTokens{value: msg.value}(0, path, address(this), deadline);
        ramenIn = IERC20(ramen).balanceOf(address(this)) - beforeBalance;
        if (ramenIn == 0) revert InvalidAmount();
        _forceApprove(ramen, address(tokenRouter), ramenIn);
        tokenOut = tokenRouter.buy(token, ramenIn, minTokenOut, recipient);
        emit EthBuy(token, msg.sender, recipient, msg.value, ramenIn, tokenOut);
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (ok && (data.length == 0 || abi.decode(data, (bool)))) return;
        (ok, data) = token.call(abi.encodeCall(IERC20.approve, (spender, 0)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        (ok, data) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
